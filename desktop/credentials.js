const $ = (id) => document.getElementById(id);
async function paint() {
  const s = await window.providerKeys.state();
  $('state').textContent = s.error ? s.error : `${s.anthropic ? 'Anthropic key saved' : 'No Anthropic key'} · ${s.github ? 'GitHub token saved' : 'No GitHub token'}`;
}
$('form').onsubmit = async (e) => {
  e.preventDefault();
  const buttons = document.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    const r = await window.providerKeys.save({ anthropicKey: $('anthropic').value, githubToken: $('github').value });
    $('status').textContent = r.error || r.message || '';
  } finally {
    $('anthropic').value = '';
    $('github').value = '';
    buttons.forEach((b) => (b.disabled = false));
    await paint();
  }
};
$('close').onclick = () => window.close();
void paint();
