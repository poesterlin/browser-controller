const field = document.querySelector('#pairing');
chrome.storage.local.get(['pairingInfo']).then((v) => (field.value = v.pairingInfo ?? ''));
document.querySelector('#pair').addEventListener('click', async () => {
  const text = field.value.trim();
  const out = document.querySelector('#result');
  try {
    const url = new URL(text);
    if (url.protocol !== 'browser-controller:' || url.hostname !== 'pair')
      throw new Error('invalid pairing string');
    const values = {
      endpoint: url.searchParams.get('endpoint'),
      pairingCode: url.searchParams.get('code'),
      adapterId: url.searchParams.get('adapter'),
    };
    if (Object.values(values).some((v) => !v)) throw new Error('pairing string is incomplete');
    const tab = await chrome.tabs.getCurrent();
    if (!Number.isInteger(tab?.id))
      throw new Error('Open this options page in a browser tab, or use the CLI pairing page');
    await chrome.storage.local.set({ ...values, pairingInfo: text, controlTabId: tab.id });
    out.textContent = ' Paired. This tab is now the browser-control tab; connecting…';
  } catch (e) {
    out.textContent = ' ' + e.message;
  }
});
