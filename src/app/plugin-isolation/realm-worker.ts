/**
 * P25 plugin capability isolation — browser/Electron worker entry point.
 * Vite emits this as a worker asset; it runs the same bootstrap function the
 * Node test path serialises (realm-bootstrap.ts), so there is one realm
 * implementation, not two.
 */
import { realmBootstrapMain } from './realm-bootstrap';

realmBootstrapMain();
