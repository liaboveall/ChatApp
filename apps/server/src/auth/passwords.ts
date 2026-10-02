/** Password hashing via the SDK's own functions, so hashes written by the domain verify at SDK sign-in and vice versa. */
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import type { PasswordHasher } from '../domain/deps.ts'

export const sdkPasswords: PasswordHasher = {
  hash: (password) => hashPassword(password),
  verify: (hash, password) => verifyPassword({ hash, password }),
}
