// Basic wrapper script. Does NOT attempt to bypass filters.
// Use only with permission.

const urlInput = document.getElementById('urlInput');
const loadBtn = document.getElementById('loadBtn');
const fitBtn = document.getElementById('fitBtn');
const siteFrame = document.getElementById('siteFrame');
const frameWrap = document.getElementById('frameWrap');
const status = document.getElementById('status');

loadBtn.addEventListener('click', () => {
  let url = urlInput.value.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    new URL(url); // validate
    siteFrame.src = url;
    status.textContent = 'Loaded: ' + url;
  } catch (e) {
    status.textContent = 'Invalid URL';
  }
});

fitBtn.addEventListener('click', () => {
  frameWrap.classList.toggle('contain');
  frameWrap.classList.toggle('fit');
});

// We cannot intercept window.open from a cross-origin iframe.
// To keep popups contained, the iframe sandbox omits allow-popups.
// For same-origin frames, below would catch link clicks that open targets.
// Provide a manual overlay message when the iframe navigates to a popup URL by listening to message events (if site cooperates).

window.addEventListener('message', (ev) => {
  // No overlay UI: ignore cooperative popup requests from embedded sites.
  // This keeps the wrapper passive for cross-origin messaging.
});

siteFrame.addEventListener('load', () => {
  try {
    // If same-origin, we could examine content, but most sites will be cross-origin.
    console.log('iframe loaded:', siteFrame.src);
  } catch (e) {
    // ignore cross-origin access errors
  }
});

// Initial state
frameWrap.classList.add('fit');