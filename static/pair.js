// The pairing page: the code made on the computer, sent once; the address the device is given opens vindu here, and is
// what to add to the Home Screen.
const $ = id => document.getElementById(id);
// a code in the address's fragment (a QR code a Pi's `vindu pair` shows): typed in for the person, and the address then
// as it was. The fragment never reaches the core.
const given = /(?:^#|&)code=(\d{6})(?:&|$)/.exec(location.hash);
if (given) { $('code').value = given[1]; history.replaceState(null, '', location.pathname); $('name').focus(); }
$('pair').addEventListener('submit', async e => {
  e.preventDefault(); $('note').textContent = '';
  const go = $('pair').querySelector('button'); go.disabled = true;
  try {
    const r = await fetch('pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('code').value.trim(), name: $('name').value.trim() }) });
    const j = await r.json().catch(() => ({ error: 'The computer did not answer as it should.' }));
    if (!r.ok || !j.url) { $('note').textContent = j.error ?? 'Not paired.'; return; }
    location.replace(j.url);
  } catch { $('note').textContent = 'The computer did not answer: is this device on its network?'; }
  finally { go.disabled = false; }
});
