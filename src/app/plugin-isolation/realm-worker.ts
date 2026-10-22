/**
 * P25 plugin capability isolation — browser/Electron worker entry point.
 * Vite emits this as a worker asset; it runs the same bootstrap function the
 * Node test path serialises (realm-bootstrap.ts), so there is one realm
 * implementation, not two.
 */
import { realmBootstrapMain } from './realm-bootstrap';

// The platform's native dynamic import, handed to the bootstrap as its
// module loader (AMENDMENT-P25-CSP-HOSTING Part B): this entry is a real
// module, so the expression is the platform's own; the bootstrap body
// deliberately contains no literal import() of its own (it is also
// serialised into the Node test realm — see realm-bootstrap.ts).
realmBootstrapMain((url) => import(url));
