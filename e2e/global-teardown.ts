import { stopXvfb } from './display'
import { removeProfile } from './profile'

/** Stop the Xvfb server global-setup spawned and drop its throwaway profile. */
export default function globalTeardown(): void {
  stopXvfb()
  removeProfile()
}
