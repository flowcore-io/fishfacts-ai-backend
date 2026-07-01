CREATE TABLE "fx_rate" (
	"year" integer NOT NULL,
	"quote" text NOT NULL,
	"rate" double precision NOT NULL,
	"as_of" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rate_year_quote_pk" PRIMARY KEY("year","quote")
);
