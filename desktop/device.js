const $ = (id) => document.getElementById(id);
const say = (text) => ($('status').textContent = text);
window.deviceCode.info().then((info) => {
  if (!info) return;
  $('code').textContent = info.userCode;
  $('open').focus();
});
$('copy').onclick = async () => say((await window.deviceCode.copy()) ? 'Code copied.' : 'Copy failed. Select the code and copy it.');
$('open').onclick = async () => say((await window.deviceCode.open()) ? 'GitHub opened in your browser. Enter the code there.' : 'GitHub couldn’t be opened. Go to github.com/login/device.');
$('cancel').onclick = () => window.deviceCode.cancel();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.deviceCode.cancel();
});
