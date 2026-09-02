// Neither the timeout nor a rejected promise can confirm how the wrapped work
// ended, so both abort as a failure. 'quit' is StopReasons.QUIT, spelled out
// here to keep this utility off TaskManager's import graph.
const ABORT_REASON = 'quit';

export function promiseTimeoutWrapper<T extends unknown>(
  promise: Promise<T>,
  expiry_time: number,
  abortController: AbortController,
): Promise<T> {
  const timeoutError = new Error(
    'Promise took too long to settle, expiry timeout met.',
  );

  // The caller's controller is an operation's own, and its abort reason is read
  // back as a StopReason. A bare abort() would set the reason to a DOMException,
  // which resolves to no status at all.
  const timer = setTimeout(() => {
    abortController.abort(ABORT_REASON);
  }, expiry_time * 1000);

  if (abortController.signal.aborted) {
    return Promise.reject(timeoutError);
  }

  return new Promise<T>((resolve, reject) => {
    const onSettled = () => {
      clearTimeout(timer);
      abortController.signal.removeEventListener('abort', abortHandler);
    };

    const abortHandler = () => {
      onSettled();
      reject(timeoutError);
    };

    abortController.signal.addEventListener('abort', abortHandler);
    promise
      .then((value) => resolve(value))
      .catch((error) => {
        abortController.abort(ABORT_REASON);
        reject(error);
      })
      .finally(onSettled);
  });
}
