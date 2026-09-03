const field = document.querySelector('#pairing');
const output = document.querySelector('#result');
chrome.storage.local.get(['pairingInfo']).then((values) => {
  field.value = values.pairingInfo ?? '';
});
document.querySelector('#pair').addEventListener('click', async () => {
  try {
    const text = field.value.trim();
    const url = new URL(text);
    if (url.protocol !== 'browser-controller:' || url.hostname !== 'pair')
      throw new Error('Invalid pairing string');
    const values = {
      endpoint: url.searchParams.get('endpoint'),
      pairingCode: url.searchParams.get('code'),
      adapterId: url.searchParams.get('adapter'),
    };
    if (Object.values(values).some((value) => !value))
      throw new Error('Pairing string is incomplete');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) throw new Error('No browser tab is available for control');
    await chrome.storage.local.set({ ...values, pairingInfo: text, controlTabId: tab.id });
    output.textContent = ' Paired. This tab is now the browser-control tab.';
  } catch (error) {
    output.textContent = ' ' + error.message;
  }
});
