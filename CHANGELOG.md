# Changelog

## [2.2.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v2.1.0...v2.2.0) (2026-08-05)


### Features

* **jmelding:** give drawn regulations a summary, a link, and an honest category ([c563718](https://github.com/flowcore-io/fishfacts-ai-backend/commit/c5637184f091ae382ddb6c0958aa942123d0c8b8))
* **jmelding:** give drawn regulations a summary, a link, and an honest category ([509b290](https://github.com/flowcore-io/fishfacts-ai-backend/commit/509b290c679a7ab80ba983c72eb011040c4dbfd0))


### Bug Fixes

* **logasavn:** keep model prose out of the re-emit suppression key ([9fec2d5](https://github.com/flowcore-io/fishfacts-ai-backend/commit/9fec2d5aa9aa528a816bb132f943d769858d1c02))

## [2.1.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v2.0.0...v2.1.0) (2026-08-04)


### Features

* **logasavn:** ingest statutory closures — LLM author, parser cross-check ([473eca5](https://github.com/flowcore-io/fishfacts-ai-backend/commit/473eca5e8326d0a5a9520898e5ca3e64c3cd274e))
* **logasavn:** ingest statutory closures with an LLM author and the parser as cross-check ([5a0de88](https://github.com/flowcore-io/fishfacts-ai-backend/commit/5a0de88db07f49992a5d0227a03f4e0fcb2e07ee))


### Bug Fixes

* **logasavn:** contain a statute failure to that statute ([350ecfa](https://github.com/flowcore-io/fishfacts-ai-backend/commit/350ecfab0bb6ad89abd01c20b337ca33626d69cd))
* **logasavn:** contain a statute failure to that statute, not just a flaky call ([c67864e](https://github.com/flowcore-io/fishfacts-ai-backend/commit/c67864e9d6c0aad3393974690ca80a3bc18df49d))
* **logasavn:** let the sweep create its own index, and run it daily ([f7c63b6](https://github.com/flowcore-io/fishfacts-ai-backend/commit/f7c63b6fc44f0ac4a180bb9e06f86a81f7bbdcc1))
* **logasavn:** let the sweep create its own index, and run it daily ([ba16a9d](https://github.com/flowcore-io/fishfacts-ai-backend/commit/ba16a9d9fbc0b696ac6c3b4f34c9e0f82b9ea765))
* **logasavn:** separate gate failures from correct declinations, guard each statute ([6bd984a](https://github.com/flowcore-io/fishfacts-ai-backend/commit/6bd984a428d471e857b39e20d4dcee933bc2592d))

## [2.0.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.31.0...v2.0.0) (2026-08-04)


### ⚠ BREAKING CHANGES

* **logasavn:** `logasavn_review` is dropped and `GET/PATCH /api/logasavn/review` no longer exist. Re-run `logasavn-sweep` after deploying to publish the index.

### Features

* **logasavn:** index the corpus, stop authoring geometry ([d4a0118](https://github.com/flowcore-io/fishfacts-ai-backend/commit/d4a0118d296767cd6bf40f3cc221cca42a62f08a))

## [1.31.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.30.0...v1.31.0) (2026-08-03)


### Features

* **logasavn:** draw approved statutory closures on the map ([18561d7](https://github.com/flowcore-io/fishfacts-ai-backend/commit/18561d7d6a0df94b35166930b9e22ca8803ac995))
* **logasavn:** draw approved statutory closures on the map ([57d3d85](https://github.com/flowcore-io/fishfacts-ai-backend/commit/57d3d855f92c004675cb4e5b8f3de3cfde9c2571))


### Bug Fixes

* **logasavn:** never retract a closure just because we could not read it ([47ef5fd](https://github.com/flowcore-io/fishfacts-ai-backend/commit/47ef5fd652608b7112c092a716397ed05e68082b))

## [1.30.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.29.0...v1.30.0) (2026-08-03)


### Features

* **logasavn:** let a human actually work the review queue ([16a9b21](https://github.com/flowcore-io/fishfacts-ai-backend/commit/16a9b21eacd938e0d353be14f93047138d1f39e0))
* **logasavn:** let a human actually work the review queue ([327d9eb](https://github.com/flowcore-io/fishfacts-ai-backend/commit/327d9eb27aff0a7578da27332abcaceb27d836fe))


### Bug Fixes

* **logasavn:** make a re-decision visible, and count the queue in SQL ([5f67e23](https://github.com/flowcore-io/fishfacts-ai-backend/commit/5f67e233b0d42f20a8467f7a230fe47fbd2de52c))

## [1.29.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.28.2...v1.29.0) (2026-08-03)


### Features

* **logasavn:** parse closure geometry from Faroese statute fragments ([69578a3](https://github.com/flowcore-io/fishfacts-ai-backend/commit/69578a39ac5b007ff0a908f49247c6394af28978))
* **logasavn:** parse closure geometry from Faroese statute fragments ([436e0ac](https://github.com/flowcore-io/fishfacts-ai-backend/commit/436e0ac9c182fd17214df7ce94a893e6fb6bf939))
* **logasavn:** sweep the corpus into a hash-pinned review queue ([65316c5](https://github.com/flowcore-io/fishfacts-ai-backend/commit/65316c5df947bfbc611406b66429324fd078e89f))
* **logasavn:** sweep the corpus into a hash-pinned review queue ([d4bdc6d](https://github.com/flowcore-io/fishfacts-ai-backend/commit/d4bdc6de63ac4b8578535f0a3e02713bb1b8df17))


### Bug Fixes

* **logasavn:** rank unknown validity below in-force, not above it ([b20113f](https://github.com/flowcore-io/fishfacts-ai-backend/commit/b20113f1bd461c9edbc85f099cb32a0328660f17))
* **logasavn:** read the corpus's real notation zoo, and fail closed on the rest ([2507918](https://github.com/flowcore-io/fishfacts-ai-backend/commit/25079185ab1bb3247ccc9ea6f454ae7018fb5707))
* **logasavn:** withhold undecidable segmentation, and mark drawableAreas pre-supersession ([d1cb297](https://github.com/flowcore-io/fishfacts-ai-backend/commit/d1cb2970db4700a18ebf38973577cacf41ad434b))

## [1.28.2](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.28.1...v1.28.2) (2026-08-03)


### Bug Fixes

* **vorn:** a well-formed slug year beats validity; assert expiry on a fixed clock ([4c28f6f](https://github.com/flowcore-io/fishfacts-ai-backend/commit/4c28f6f8fa626a13317ecfe8c8a29b9f734c280a))
* **vorn:** stop truncating typo'd slugs into 404s, title the year from the body ([26ba2f7](https://github.com/flowcore-io/fishfacts-ai-backend/commit/26ba2f7b989aaf021d36d2955b5e876786689dbd))
* **vorn:** stop truncating typo'd slugs into 404s, title the year from the body ([26e4211](https://github.com/flowcore-io/fishfacts-ai-backend/commit/26e4211b760940c17a0be67afee66132db247cce))

## [1.28.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.28.0...v1.28.1) (2026-07-31)


### Bug Fixes

* **jmeldinger:** finish the normalisation and cover the branch it promises ([1d53b10](https://github.com/flowcore-io/fishfacts-ai-backend/commit/1d53b1078292598d6155353707e00930036ceb69))
* **jmeldinger:** read row timestamps as the driver actually returns them ([044fa8e](https://github.com/flowcore-io/fishfacts-ai-backend/commit/044fa8ea05b993b0730accb381629afd8f06ddf8))
* **jmeldinger:** read row timestamps as the driver actually returns them ([898fce0](https://github.com/flowcore-io/fishfacts-ai-backend/commit/898fce0bc5a300b0d24e8baa715eb6d370640b77))

## [1.28.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.27.0...v1.28.0) (2026-07-31)


### Features

* **jmeldinger:** sync Usable fragments from the repaired read model ([50b430b](https://github.com/flowcore-io/fishfacts-ai-backend/commit/50b430b1b195ba56f8e95611cbcfb6400b519c2e))
* **jmeldinger:** sync Usable fragments from the repaired read model ([e7c8ec2](https://github.com/flowcore-io/fishfacts-ai-backend/commit/e7c8ec24a6a8167e22a7b345526846b70b969777))


### Bug Fixes

* **jmeldinger:** make the fragment sync runnable, correct, and testable ([23497ad](https://github.com/flowcore-io/fishfacts-ai-backend/commit/23497ad837f4eb88d5d71034e032ab148c424699))
* **jmeldinger:** say when a --limit dry run is not a corpus-wide count ([ee76cc5](https://github.com/flowcore-io/fishfacts-ai-backend/commit/ee76cc53248cb62da97f70d59ac899c7aadfd3ac))

## [1.27.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.26.1...v1.27.0) (2026-07-31)


### Features

* **reports:** attach the map screenshot to issue reports as a file ([2c20845](https://github.com/flowcore-io/fishfacts-ai-backend/commit/2c20845fd40107eab73ebfd5cd7a5e02890c73df))

## [1.26.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.26.0...v1.26.1) (2026-07-31)


### Bug Fixes

* **jmeldinger:** address review — reachable statuses, parseable dates, honest runbook ([46efebd](https://github.com/flowcore-io/fishfacts-ai-backend/commit/46efebd11250b49581949fe88cf8e636e614835c))
* **jmeldinger:** decide "current" against the clock, not a keyword ([c73f7e9](https://github.com/flowcore-io/fishfacts-ai-backend/commit/c73f7e9a77cf8acf0dc4ebe65751aa1b6033b076))
* **jmeldinger:** decide "current" against the clock, not a keyword ([0d84cd3](https://github.com/flowcore-io/fishfacts-ai-backend/commit/0d84cd3adff25d04fbddf303186cef6fd4d7ee98))
* **jmeldinger:** re-derive stored FO geometry without replaying the pathway ([a382e39](https://github.com/flowcore-io/fishfacts-ai-backend/commit/a382e398ad920bd9fc08ca4374904f56edc59a4b))

## [1.26.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.25.0...v1.26.0) (2026-07-31)


### Features

* **reports:** accept and render the FE's map state and route ([c203cc6](https://github.com/flowcore-io/fishfacts-ai-backend/commit/c203cc6881d6c2debfce2566a18d5a5faa0831ac))
* **reports:** capture the map view and route in issue reports ([0eb7025](https://github.com/flowcore-io/fishfacts-ai-backend/commit/0eb70258c219a69fb7661ccb437c0c7721e9c547))


### Bug Fixes

* **reports:** map state fails closed; strip the query from route ([9a806d1](https://github.com/flowcore-io/fishfacts-ai-backend/commit/9a806d11a4f6c88888b30423a7665f0637585652))
* **reports:** review pass — selectedTotals, and no zero in-view line off-map ([15fa594](https://github.com/flowcore-io/fishfacts-ai-backend/commit/15fa5945068a4115c9c73c294deae851bb0fe775))

## [1.25.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.24.0...v1.25.0) (2026-07-29)


### Features

* **reports:** agent-readability round — clip accounting, failure markers, timestamps ([0165768](https://github.com/flowcore-io/fishfacts-ai-backend/commit/01657683781eaf130062b238b2e4c4d9689b4289))
* **reports:** agent-readability round — FE clip accounting, failure markers, timestamps ([c160d95](https://github.com/flowcore-io/fishfacts-ai-backend/commit/c160d95356ea746027bed6844030a8bd3cf8807f))


### Bug Fixes

* **reports:** PR-review round — inline tool names in summary, cap feClippedValues, verbatim-string test ([a041660](https://github.com/flowcore-io/fishfacts-ai-backend/commit/a0416609152be7e6e9d5fae59f70deadf6910cfc))

## [1.24.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.23.1...v1.24.0) (2026-07-29)


### Features

* **poi:** admin-gated durable POI write — POST /api/poi via poi.created.0 event + fragment projector ([1daaf6e](https://github.com/flowcore-io/fishfacts-ai-backend/commit/1daaf6e8220f6057fa8d71fd61a2d39e070c5a2b))
* **poi:** admin-gated durable POI write (POST /api/poi, event-sourced) ([9cfca3f](https://github.com/flowcore-io/fishfacts-ai-backend/commit/9cfca3f7c6c0f537248ba93d92e72ca8394c288a))
* **reports:** in-chat issue report ingest + admin Usable proxy routes ([34e1b9e](https://github.com/flowcore-io/fishfacts-ai-backend/commit/34e1b9e3bf9e5919884af9589979df8d1f7b12ca))
* **reports:** in-chat issue report ingest + admin Usable proxy routes ([f6a0cf4](https://github.com/flowcore-io/fishfacts-ai-backend/commit/f6a0cf4a0a39f7394d4105a51da7874eac95198a))


### Bug Fixes

* **poi:** review fixes — JSON.stringify YAML scalars, single-source key regex + title prefix ([8031e91](https://github.com/flowcore-io/fishfacts-ai-backend/commit/8031e91bb159d17f2e0e9cd6a661ad91d0311ab3))
* **reports:** drain oversized bodies before the 413 response ([dc9aabf](https://github.com/flowcore-io/fishfacts-ai-backend/commit/dc9aabf419b7a2c21307ce1b3586b37de673d0f6))
* **reports:** PR-review round — sanitise unfenced scalars, fail-closed type check, JSON 413 ([01c877b](https://github.com/flowcore-io/fishfacts-ai-backend/commit/01c877b434457385671cefad7e1836399cb55b3d))
* **reports:** review-pass hardening — leak, fences, scope, limits ([a2c06f1](https://github.com/flowcore-io/fishfacts-ai-backend/commit/a2c06f1eb6ad8958cb490d3f973a39885cbb7fe1))

## [1.23.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.23.0...v1.23.1) (2026-07-22)


### Bug Fixes

* **poi:** parse frontmatter from fragment content — REST responses omit the frontmatter column ([dee8523](https://github.com/flowcore-io/fishfacts-ai-backend/commit/dee85239361464789733dbeb28ae1071ae978c7f))
* **poi:** parse frontmatter from fragment content — REST responses omit the frontmatter column ([569d563](https://github.com/flowcore-io/fishfacts-ai-backend/commit/569d563ffc1a5994ec5cb14542c2d2e7b036b034))

## [1.23.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.22.3...v1.23.0) (2026-07-22)


### Features

* **poi:** serve the Point-of-Interest gazetteer from Usable fragments ([9d142b3](https://github.com/flowcore-io/fishfacts-ai-backend/commit/9d142b3824a0abb2a5c8b3ba041a0406d0a00ddf))
* **poi:** serve the Point-of-Interest gazetteer from Usable fragments ([d8008ab](https://github.com/flowcore-io/fishfacts-ai-backend/commit/d8008abbe8b58503bdfe369622b5e938d07cd4af))


### Bug Fixes

* **poi:** fail refresh on transient detail-fetch errors; parallelize detail fetches ([d794b27](https://github.com/flowcore-io/fishfacts-ai-backend/commit/d794b279998ff07b7c38f20fc528c7fbe1e272fd))

## [1.22.3](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.22.2...v1.22.3) (2026-07-08)


### Bug Fixes

* **vorn:** normalize closure rings in the geo projector, keep events faithful ([1ff8c9c](https://github.com/flowcore-io/fishfacts-ai-backend/commit/1ff8c9cb23eee90475f97f7cafa1322639985a32))
* **vorn:** normalize closure rings in the geo projector, keep events faithful ([00c47b1](https://github.com/flowcore-io/fishfacts-ai-backend/commit/00c47b1f8d24b2d8ce57761b2fa211c0cdf4c040))

## [1.22.2](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.22.1...v1.22.2) (2026-07-08)


### Bug Fixes

* **vorn:** recover typo'd closing vertex in veiðibann rings ([98b7004](https://github.com/flowcore-io/fishfacts-ai-backend/commit/98b700484a90da1fe39ce7c13d71e8d0d629f5b2))

## [1.22.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.22.0...v1.22.1) (2026-07-06)


### Bug Fixes

* **ais:** qualify speed column in getTracks WHERE (fixes POST /tracks 500) ([764a969](https://github.com/flowcore-io/fishfacts-ai-backend/commit/764a9696d8c6affa3a6de125c28e62d7643fe50b))
* **ais:** qualify speed column in getTracks WHERE (ILLEGAL_AGGREGATION) ([aeac364](https://github.com/flowcore-io/fishfacts-ai-backend/commit/aeac364a67c37cbd6438ab3f3fa56b9c3f3ec585))

## [1.22.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.21.2...v1.22.0) (2026-07-06)


### Features

* **ais:** polygon clip + speed band for vessel tracks ([1abd081](https://github.com/flowcore-io/fishfacts-ai-backend/commit/1abd081a187c7ca98d44f156a68506ca523d9fc6))
* **ais:** polygon clip + speed band for vessel tracks ([fe7f763](https://github.com/flowcore-io/fishfacts-ai-backend/commit/fe7f7639711a00c8fedd5f914dfc65c773caf697))

## [1.21.2](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.21.1...v1.21.2) (2026-07-03)


### Bug Fixes

* **ais:** raise effort/density query budget to 55s ([#96](https://github.com/flowcore-io/fishfacts-ai-backend/issues/96)) ([254a090](https://github.com/flowcore-io/fishfacts-ai-backend/commit/254a090171cfcefc0c1d8997d51a49c4934d93dc))

## [1.21.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.21.0...v1.21.1) (2026-07-02)


### Bug Fixes

* **ais:** release the polygon-literal query fix for effort and density ([9bd0417](https://github.com/flowcore-io/fishfacts-ai-backend/commit/9bd04177de8d1daf4ac75bddbdfc71df891c6038))

## [1.21.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.20.0...v1.21.0) (2026-07-02)


### Features

* **ais:** per-vessel fishing-effort endpoint + polygon clip on density ([#92](https://github.com/flowcore-io/fishfacts-ai-backend/issues/92)) ([fde2772](https://github.com/flowcore-io/fishfacts-ai-backend/commit/fde27723860afdc98a1b32440b3c6564246f4607))

## [1.20.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.19.0...v1.20.0) (2026-07-01)


### Features

* **financials:** FX + cross-company market/compare + categories ([#90](https://github.com/flowcore-io/fishfacts-ai-backend/issues/90)) ([7c4bd86](https://github.com/flowcore-io/fishfacts-ai-backend/commit/7c4bd8656e1cbe9cd14cbe173310cb3b6fa74615))

## [1.19.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.18.1...v1.19.0) (2026-07-01)


### Features

* **financials:** annual-report financials API (single-company, native currency) ([#88](https://github.com/flowcore-io/fishfacts-ai-backend/issues/88)) ([e4f0fe2](https://github.com/flowcore-io/fishfacts-ai-backend/commit/e4f0fe236a7fa173b09dec66126ddf3e5e33b1e7))

## [1.18.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.18.0...v1.18.1) (2026-06-29)


### Bug Fixes

* **closures:** match Vørn veiðibann typo'd slugs (nr 12/13 were missed) ([#86](https://github.com/flowcore-io/fishfacts-ai-backend/issues/86)) ([e559183](https://github.com/flowcore-io/fishfacts-ai-backend/commit/e5591832cc81c8fdf0f0da3e3a95716990e5e95e))

## [1.18.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.17.0...v1.18.0) (2026-06-24)


### Features

* **ais:** vesselIds gear filter on /api/ais/density (GET+POST) ([#84](https://github.com/flowcore-io/fishfacts-ai-backend/issues/84)) ([c64efaf](https://github.com/flowcore-io/fishfacts-ai-backend/commit/c64efaf089eabdad1bc914150b5ca46dbf0dda17))

## [1.17.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.16.1...v1.17.0) (2026-06-24)


### Features

* **ais:** GET /api/ais/density — fleet-density grid for area recommendations ([#82](https://github.com/flowcore-io/fishfacts-ai-backend/issues/82)) ([d82ddc6](https://github.com/flowcore-io/fishfacts-ai-backend/commit/d82ddc6396781d1c3b541d98f9b89c32f1d97510))

## [1.16.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.16.0...v1.16.1) (2026-06-23)


### Bug Fixes

* **gebco:** raise pump concurrency to 48 for the gebco flow type ([#80](https://github.com/flowcore-io/fishfacts-ai-backend/issues/80)) ([842979b](https://github.com/flowcore-io/fishfacts-ai-backend/commit/842979b392d9b40fbc515bc2b7bf9abf04138096))

## [1.16.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.15.1...v1.16.0) (2026-06-23)


### Features

* **gebco:** ingest GEBCO undersea feature names into PostGIS geo index ([#78](https://github.com/flowcore-io/fishfacts-ai-backend/issues/78)) ([1905267](https://github.com/flowcore-io/fishfacts-ai-backend/commit/1905267c76f2542dccc10152661fa48d8ef93558))

## [1.15.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.15.0...v1.15.1) (2026-06-23)


### Bug Fixes

* bump @flowcore/pathways to 2.4.6 (guarded notification-client JSON.parse) ([#76](https://github.com/flowcore-io/fishfacts-ai-backend/issues/76)) ([b41f0d7](https://github.com/flowcore-io/fishfacts-ai-backend/commit/b41f0d7a3ef483eac618cdb62aea7b9b653c9625))

## [1.15.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.14.0...v1.15.0) (2026-06-23)


### Features

* **jobs:** move job-state store from Usable fragments to Postgres ([#73](https://github.com/flowcore-io/fishfacts-ai-backend/issues/73)) ([c548d83](https://github.com/flowcore-io/fishfacts-ai-backend/commit/c548d8314c10a2a27de6e9c340945fef5367ee65))

## [1.14.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.13.0...v1.14.0) (2026-06-19)


### Features

* **closures:** bulk-draw endpoint for whole regulation sets ([#71](https://github.com/flowcore-io/fishfacts-ai-backend/issues/71)) ([2384391](https://github.com/flowcore-io/fishfacts-ai-backend/commit/23843914c64d47d0beba5eb2497d4b448cd72f65))

## [1.13.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.12.0...v1.13.0) (2026-06-19)


### Features

* **closures:** expose closure type (category) in geo search ([#69](https://github.com/flowcore-io/fishfacts-ai-backend/issues/69)) ([e80ee31](https://github.com/flowcore-io/fishfacts-ai-backend/commit/e80ee31948ee66305ac84e2ebd117d5a189132ba))

## [1.12.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.11.1...v1.12.0) (2026-06-19)


### Features

* **gillnet:** ingest Faroese gillnet positions (Vørn daily snapshot) ([#67](https://github.com/flowcore-io/fishfacts-ai-backend/issues/67)) ([64f22f0](https://github.com/flowcore-io/fishfacts-ai-backend/commit/64f22f060a1b68526c8332fcc091cb80b20cd071))

## [1.11.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.11.0...v1.11.1) (2026-06-19)


### Bug Fixes

* **pump:** raise default pump concurrency to 8 for low-volume flows ([#65](https://github.com/flowcore-io/fishfacts-ai-backend/issues/65)) ([53c56a3](https://github.com/flowcore-io/fishfacts-ai-backend/commit/53c56a31ffc61b1fe0f6e82c373c9deee259a4d9))

## [1.11.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.10.8...v1.11.0) (2026-06-19)


### Features

* **closures:** Faroese & Icelandic closures in the shared geo index ([#63](https://github.com/flowcore-io/fishfacts-ai-backend/issues/63)) ([8229bb6](https://github.com/flowcore-io/fishfacts-ai-backend/commit/8229bb677c89c52f87d1c3fdbd96890822ace072))

## [1.10.8](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.10.7...v1.10.8) (2026-06-18)


### Bug Fixes

* **jobs:** stop hammering Usable with job-state writes (PATCH storm) ([#61](https://github.com/flowcore-io/fishfacts-ai-backend/issues/61)) ([0ccbb1e](https://github.com/flowcore-io/fishfacts-ai-backend/commit/0ccbb1ea9ea29a6e0f7d5ed3f5e96b9bad91b37e))

## [1.10.7](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.10.6...v1.10.7) (2026-06-18)


### Bug Fixes

* **ais:** batch the live tail emit (was 1 event per webhook request) ([#59](https://github.com/flowcore-io/fishfacts-ai-backend/issues/59)) ([d5aaf1c](https://github.com/flowcore-io/fishfacts-ai-backend/commit/d5aaf1c0a88c2093168a5199706132ebf26ee1d2))

## [1.10.6](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.10.5...v1.10.6) (2026-06-18)


### Bug Fixes

* **ais:** dedicated MySQL pool for the live tail (isolate from backfill) ([#57](https://github.com/flowcore-io/fishfacts-ai-backend/issues/57)) ([b10cf48](https://github.com/flowcore-io/fishfacts-ai-backend/commit/b10cf4890eb3cf05b0e1828d5a74266047c7588a))

## [1.10.5](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.10.4...v1.10.5) (2026-06-18)


### Bug Fixes

* **ais:** raise CH-refill page deadline 15s -&gt; 120s ([#55](https://github.com/flowcore-io/fishfacts-ai-backend/issues/55)) ([24698af](https://github.com/flowcore-io/fishfacts-ai-backend/commit/24698affebde8715613b7a5219e82369075ed12c))

## [1.10.4](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.10.3...v1.10.4) (2026-06-18)


### Bug Fixes

* **ais:** tighten CH-refill page deadline to 15s for faster shrink ([#53](https://github.com/flowcore-io/fishfacts-ai-backend/issues/53)) ([7f56800](https://github.com/flowcore-io/fishfacts-ai-backend/commit/7f5680038ebe003135398ba28771f8bc71012cdb))

## [1.10.3](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.10.2...v1.10.3) (2026-06-18)


### Bug Fixes

* **ais:** adaptive page-size shrink for CH refill on dense buckets ([#51](https://github.com/flowcore-io/fishfacts-ai-backend/issues/51)) ([099be06](https://github.com/flowcore-io/fishfacts-ai-backend/commit/099be0619bfdca7e2341774c52ddfea77be167a3))

## [1.10.2](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.10.1...v1.10.2) (2026-06-17)


### Bug Fixes

* resume CH-refill mid-bucket via persisted cursor (handle huge buckets) ([#49](https://github.com/flowcore-io/fishfacts-ai-backend/issues/49)) ([7cc0212](https://github.com/flowcore-io/fishfacts-ai-backend/commit/7cc02127f7d08d1fe494b44e6d8609d8a777f496))

## [1.10.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.10.0...v1.10.1) (2026-06-17)


### Bug Fixes

* timeout Flowcore fetch in the CH-refill reader ([#47](https://github.com/flowcore-io/fishfacts-ai-backend/issues/47)) ([d45a497](https://github.com/flowcore-io/fishfacts-ai-backend/commit/d45a4974c67a5d5e74b055f42ad16bf3d80efab5))

## [1.10.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.9.0...v1.10.0) (2026-06-17)


### Features

* decouple AIS backfill into emit + separate CH-refill jobs ([#45](https://github.com/flowcore-io/fishfacts-ai-backend/issues/45)) ([5caa408](https://github.com/flowcore-io/fishfacts-ai-backend/commit/5caa40859593ade05fcee8883d3fa0089844a66e))

## [1.9.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.8.0...v1.9.0) (2026-06-17)


### Features

* AIS vessel-position pipeline + resilient forward-fill/backfill ([#43](https://github.com/flowcore-io/fishfacts-ai-backend/issues/43)) ([a5e7e22](https://github.com/flowcore-io/fishfacts-ai-backend/commit/a5e7e22f1f598487d646c75f465d2fe22c431d81))

## [1.8.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.7.4...v1.8.0) (2026-06-04)


### Features

* enrich sildelaget catches with route areas ([130c8a9](https://github.com/flowcore-io/fishfacts-ai-backend/commit/130c8a92750a7da9c0b8da69230cfd66b974dfcc))

## [1.7.4](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.7.3...v1.7.4) (2026-06-04)


### Bug Fixes

* configure pathway timeout and websocket notifier ([ef53c55](https://github.com/flowcore-io/fishfacts-ai-backend/commit/ef53c55ef551febe8236f5ed76d77acbd62c615c))

## [1.7.3](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.7.2...v1.7.3) (2026-06-04)


### Bug Fixes

* require admin for operational routes ([dcf8d7c](https://github.com/flowcore-io/fishfacts-ai-backend/commit/dcf8d7cbf10295187b3303ce3a52688d5d810f40))

## [1.7.2](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.7.1...v1.7.2) (2026-06-04)


### Bug Fixes

* document sildelaget manual backfill duration ([a2272d7](https://github.com/flowcore-io/fishfacts-ai-backend/commit/a2272d7e9692910d2d9a66bc75f8e69250b43536))

## [1.7.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.7.0...v1.7.1) (2026-06-04)


### Bug Fixes

* parse sildelaget namespaced xlsx exports ([8ae9937](https://github.com/flowcore-io/fishfacts-ai-backend/commit/8ae9937fea0203b7a6fb6a04f12f39d648480e88))

## [1.7.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.6.0...v1.7.0) (2026-06-03)


### Features

* add sildelaget catch API ([7158c07](https://github.com/flowcore-io/fishfacts-ai-backend/commit/7158c07a6a4a30ca78432093a63dba4eba496597))

## [1.6.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.5.1...v1.6.0) (2026-06-02)


### Features

* **api:** areas CRUD + MVT tiles + full swagger docs ([#35](https://github.com/flowcore-io/fishfacts-ai-backend/issues/35)) ([e31fcc2](https://github.com/flowcore-io/fishfacts-ai-backend/commit/e31fcc2b306fc2f1eef3d03e43128eca2b9d029b))

## [1.5.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.5.0...v1.5.1) (2026-05-18)


### Bug Fixes

* **jobs:** release runner lock when initial state-store save fails ([#33](https://github.com/flowcore-io/fishfacts-ai-backend/issues/33)) ([a640ec3](https://github.com/flowcore-io/fishfacts-ai-backend/commit/a640ec305fc9b992c1f8813c4de427e651a0d3e5))

## [1.5.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.4.3...v1.5.0) (2026-05-13)


### Features

* **jobs:** add diagnostic logging to scraper + runner ([#31](https://github.com/flowcore-io/fishfacts-ai-backend/issues/31)) ([a8ab3ef](https://github.com/flowcore-io/fishfacts-ai-backend/commit/a8ab3efb94e6a187c58df1b14fab66eb115edeaf))

## [1.4.3](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.4.2...v1.4.3) (2026-05-13)


### Bug Fixes

* **jobs:** runner never leaves lastRunStatus stuck at running + CLAUDE.md runbook ([#29](https://github.com/flowcore-io/fishfacts-ai-backend/issues/29)) ([ca759d3](https://github.com/flowcore-io/fishfacts-ai-backend/commit/ca759d330842a216df941354bbcd21ec174b9783))

## [1.4.2](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.4.1...v1.4.2) (2026-05-12)


### Bug Fixes

* **pathways:** re-enable autoProvision.pathway for pulses + restart commands ([#27](https://github.com/flowcore-io/fishfacts-ai-backend/issues/27)) ([472d243](https://github.com/flowcore-io/fishfacts-ai-backend/commit/472d243431a45520aba5d54bd6f49c48013606b3))

## [1.4.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.4.0...v1.4.1) (2026-05-12)


### Bug Fixes

* include drizzle/meta in Docker image for migrations ([#25](https://github.com/flowcore-io/fishfacts-ai-backend/issues/25)) ([b440826](https://github.com/flowcore-io/fishfacts-ai-backend/commit/b440826a6000af8579f32c208edc66b1fe7edac6))

## [1.4.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.3.1...v1.4.0) (2026-05-12)


### Features

* jmelding geo API + switch prod to dedicated fishfacts tenant ([#23](https://github.com/flowcore-io/fishfacts-ai-backend/issues/23)) ([606a062](https://github.com/flowcore-io/fishfacts-ai-backend/commit/606a06284cd6a39abf51959bfcc707e5896ee4ea))

## [1.3.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.3.0...v1.3.1) (2026-05-07)


### Bug Fixes

* **jobs:** refreshExisting=true bypasses listing-fingerprint short-circuit ([#21](https://github.com/flowcore-io/fishfacts-ai-backend/issues/21)) ([9887002](https://github.com/flowcore-io/fishfacts-ai-backend/commit/988700221f120b0127c14b36860156cb45644faf))

## [1.3.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.2.2...v1.3.0) (2026-05-07)


### Features

* **events:** activate j-melding chunking for events over 60KB ([#19](https://github.com/flowcore-io/fishfacts-ai-backend/issues/19)) ([476468d](https://github.com/flowcore-io/fishfacts-ai-backend/commit/476468dcb137c6acfc88793193edffda23426ec8))

## [1.2.2](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.2.1...v1.2.2) (2026-05-07)


### Bug Fixes

* **pathways:** omit chunking metadata for non-chunked j-melding writes ([#17](https://github.com/flowcore-io/fishfacts-ai-backend/issues/17)) ([9898b6b](https://github.com/flowcore-io/fishfacts-ai-backend/commit/9898b6bc7f850d454ed75f40a645484c05966680))

## [1.2.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.2.0...v1.2.1) (2026-05-07)


### Bug Fixes

* **jobs:** restore 30000-char bodyMarkdown cap to keep events well under 64KB ([#15](https://github.com/flowcore-io/fishfacts-ai-backend/issues/15)) ([bdc992b](https://github.com/flowcore-io/fishfacts-ai-backend/commit/bdc992b1230fd4f2e30f52c099f2ba504ea1b158))

## [1.2.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.1.3...v1.2.0) (2026-05-07)


### Features

* **events:** chunk j-melding announcements over 60KB and reassemble in handler ([#11](https://github.com/flowcore-io/fishfacts-ai-backend/issues/11)) ([d452b2e](https://github.com/flowcore-io/fishfacts-ai-backend/commit/d452b2eed87e467cfa728c29bcd3368ad7695416))

## [1.1.3](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.1.2...v1.1.3) (2026-05-07)


### Bug Fixes

* **pathways:** write j-melding events fire-and-forget so jobs don't block 10s ([#9](https://github.com/flowcore-io/fishfacts-ai-backend/issues/9)) ([4b81485](https://github.com/flowcore-io/fishfacts-ai-backend/commit/4b814852dfc6c7cfdff087ae3911c0e322e13b66))

## [1.1.2](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.1.1...v1.1.2) (2026-05-07)


### Bug Fixes

* **jobs:** cap j-melding bodyMarkdown so events fit Flowcore 64KB limit ([#7](https://github.com/flowcore-io/fishfacts-ai-backend/issues/7)) ([2fe5494](https://github.com/flowcore-io/fishfacts-ai-backend/commit/2fe5494b5e66214a092a31b9c557e1f56d20f260))

## [1.1.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.1.0...v1.1.1) (2026-05-07)


### Bug Fixes

* **jobs:** capture upstream response in job error message ([#5](https://github.com/flowcore-io/fishfacts-ai-backend/issues/5)) ([965fa7e](https://github.com/flowcore-io/fishfacts-ai-backend/commit/965fa7e79ab85019d2bc1222462aed65c3393a64))

## [1.1.0](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.0.1...v1.1.0) (2026-05-06)


### Features

* **auth:** add x-auth-token middleware that validates against fishfacts.fo ([#3](https://github.com/flowcore-io/fishfacts-ai-backend/issues/3)) ([35191a3](https://github.com/flowcore-io/fishfacts-ai-backend/commit/35191a3f7282973fe98aa161cfe453566659071f))

## [1.0.1](https://github.com/flowcore-io/fishfacts-ai-backend/compare/v1.0.0...v1.0.1) (2026-05-06)


### Bug Fixes

* **pathways:** wire virtual pathway with cluster mode for production ([d2fe3cf](https://github.com/flowcore-io/fishfacts-ai-backend/commit/d2fe3cfea9d85c0cd6a443d05dacf9268143da61))

## 1.0.0 (2026-05-06)


### Features

* initial release ([356e035](https://github.com/flowcore-io/fishfacts-ai-backend/commit/356e0357202da5184b788298b196ffcbe74c7781))


### Bug Fixes

* **test:** use grep instead of rg for portability in CI ([86f6ba2](https://github.com/flowcore-io/fishfacts-ai-backend/commit/86f6ba2867b7fb9b0eeb3ee934af59946188bad6))
