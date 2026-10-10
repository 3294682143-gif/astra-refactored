/**
 * P1 offline Node stdio entry point.
 *
 * Mock-only local prototype: no real provider, no network, no tool execution
 * and no Python solver. The P0 entry point (`main.ts`) is untouched.
 */

import { runP1 } from "./p1-controller.js";

runP1();
