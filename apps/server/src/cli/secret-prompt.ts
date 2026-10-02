/** Reads a secret from the terminal without echo, or the first line of piped stdin (for scripted setup). Never logs it. */
import { createInterface } from 'node:readline'

export async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin })
    for await (const line of rl) {
      rl.close()
      return line
    }
    return ''
  }
  process.stdout.write(prompt)
  return await new Promise<string>((resolve, reject) => {
    const stdin = process.stdin
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const finish = (result: () => void) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      process.stdout.write('\n')
      result()
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish(() => resolve(value))
        if (char === '\u0003') return finish(() => reject(new Error('cancelled')))
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    stdin.on('data', onData)
  })
}
