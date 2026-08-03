import { describe, expect, test } from "bun:test";
import type { JMeldingAnnouncementDiscovered } from "@/events/contracts";
import { JMeldingChunkAssembler } from "./jmelding-chunk-assembler";

/**
 * A non-chunked announcement goes straight to the projectors without touching
 * the queue table, so these run against fakes with no database.
 */
function announcement(
  over: Partial<JMeldingAnnouncementDiscovered> = {},
): JMeldingAnnouncementDiscovered {
  return {
    signature: "sig-1",
    title: "Kunngerð nr. 35 (2026) — Føroyabanki",
    url: "https://logir.fo/Kunngerd/35-fra-2026",
    status: "current",
    jmNumber: "LOG-K-35-2026",
    region: "FO",
    bodyMarkdown: "",
    checkedAt: "2026-08-03T21:00:00.000Z",
    ...over,
  } as JMeldingAnnouncementDiscovered;
}

function fakes(options: { fragmentProjectorThrows?: boolean } = {}) {
  const calls = {
    fragmentProjected: 0,
    geoFragmentIds: [] as (string | null)[],
  };
  const projector = {
    project: async () => {
      calls.fragmentProjected += 1;
      if (options.fragmentProjectorThrows) throw new Error("usable is down");
      return { fragmentId: "our-own-copy" };
    },
  };
  const geoProjector = {
    project: async (
      _item: JMeldingAnnouncementDiscovered,
      fragmentId: string | null,
    ) => {
      calls.geoFragmentIds.push(fragmentId);
    },
  };
  const assembler = new JMeldingChunkAssembler(
    {} as never,
    projector as never,
    geoProjector as never,
  );
  return { assembler, calls };
}

describe("JMeldingChunkAssembler — sourceFragmentId", () => {
  // Decision 6: one copy of the law. The Lógasavn mirror is the record, and
  // writing our own fragment would give us two things to keep in step.
  test("does not write a fragment copy when the source already exists", async () => {
    const { assembler, calls } = fakes();

    await assembler.handle(
      announcement({ sourceFragmentId: "logasavn-fragment-id" }),
    );

    expect(calls.fragmentProjected).toBe(0);
    expect(calls.geoFragmentIds).toEqual(["logasavn-fragment-id"]);
  });

  test("still writes its own fragment when there is no source to point at", async () => {
    const { assembler, calls } = fakes();

    await assembler.handle(announcement());

    expect(calls.fragmentProjected).toBe(1);
    expect(calls.geoFragmentIds).toEqual(["our-own-copy"]);
  });

  // Pre-existing behaviour that must survive the change: geometry is worth
  // landing even when the fragment copy failed.
  test("a failed fragment projection still lands the geometry", async () => {
    const { assembler, calls } = fakes({ fragmentProjectorThrows: true });

    await assembler.handle(announcement());

    expect(calls.fragmentProjected).toBe(1);
    expect(calls.geoFragmentIds).toEqual([null]);
  });
});
