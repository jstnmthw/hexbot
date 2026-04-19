// HexBot — Shared type definitions (façade)
//
// This file is a re-export surface for the split type modules under
// `src/types/`. It exists so the long-standing `import { … } from '../types'`
// idiom across ~40 source files keeps working unchanged; authors adding new
// types should add them to the appropriate split module (dispatch, config,
// or plugin-api) rather than back into this file.
//
// Split layout:
// - `src/types/dispatch.ts`   — bind system, handler contexts, casemapping
// - `src/types/config.ts`     — runtime + on-disk config shapes
// - `src/types/plugin-api.ts` — plugin API, channel/user records, help, settings

export * from './types/dispatch';
export * from './types/config';
export * from './types/plugin-api';
