window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== 'browser-controller-pair') return;
  chrome.runtime.sendMessage({
    type: 'pair',
    endpoint: event.data.endpoint,
    code: event.data.code,
    adapterId: event.data.adapterId,
  });
});
