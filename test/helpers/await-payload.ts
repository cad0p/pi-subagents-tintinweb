/**
 * Faux providers never call `options.onPayload`, but pi runs the
 * `before_provider_request` hook there (the slot gate lives in that hook). This
 * wraps the faux api so each request awaits `onPayload` before the scripted
 * responder runs, which is when the request counts as "sent".
 *
 * Returns a disposer that removes the wrapper.
 */
import {
  type ApiStreamSimpleFunction,
  createAssistantMessageEventStream,
  getApiProvider,
  registerApiProvider,
  unregisterApiProviders,
} from "./pi-ai.js";

let wrapperCount = 0;

function holdUntilPayloadAwaited(stream: ApiStreamSimpleFunction): ApiStreamSimpleFunction {
  return (model, context, options) => {
    const out = createAssistantMessageEventStream();
    void (async () => {
      await options?.onPayload?.({ model: model.id }, model);
      for await (const event of stream(model, context, options)) {
        out.push(event);
      }
      out.end();
    })();
    return out;
  };
}

export function awaitPayloadOnFaux(api: string): () => void {
  const inner = getApiProvider(api);
  if (!inner) {
    throw new Error(`awaitPayloadOnFaux: no provider registered for api "${api}"`);
  }
  const sourceId = `await-payload-${++wrapperCount}`;
  registerApiProvider(
    {
      api: inner.api,
      stream: holdUntilPayloadAwaited(inner.stream),
      streamSimple: holdUntilPayloadAwaited(inner.streamSimple),
    },
    sourceId,
  );
  return () => unregisterApiProviders(sourceId);
}
