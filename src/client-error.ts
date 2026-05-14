// BridgeRequestError now lives in shared.ts so transport-side code (which
// must not import the client entry) can throw the same canonical error
// class. Re-exported here to keep the historical `./client-error` import
// path stable for client.ts, router.ts, and their tests.
export { BridgeRequestError } from './shared';
