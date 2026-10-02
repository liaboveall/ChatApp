// Loaded by `bun test` (see bunfig.toml). Integration tests must never see a development or production
// APP_ENV: the config loader swaps in the *_TEST database, Valkey db and bucket only for APP_ENV=test.
process.env.APP_ENV = 'test'
