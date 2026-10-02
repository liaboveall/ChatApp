/**
 * Bun adapter for identifiers (D-090). The auth layer and the domain receive an `IdGenerator`; nothing outside
 * runtime/ and the composition roots references Bun directly.
 */
export type IdGenerator = () => string

/** UUIDv7: time-ordered, so primary keys stay index-friendly. Never used as an authorization secret. */
export const uuidv7: IdGenerator = () => Bun.randomUUIDv7()
