/**
 * The public account deletion page (/account/delete): the web deletion link Google Play's Data safety form asks for,
 * and the way to delete an account without the app. Phone number → code → delete; the same API as the app
 * (POST /d/v1/account/delete/start, POST /d/v1/account/delete). No inline script (CSP): /d/account-delete.js.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function accountDeletePage(appName: string, accent = '#2fd6a7'): string {
  const n = esc(appName);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Delete your ${n} account</title>
<style>
:root{--bg:#0a1417;--fg:#e8f0ef;--muted:#9fb3b0;--card:#0f1e22;--accent:${esc(accent)}}
@media (prefers-color-scheme:light){:root{--bg:#f2f6f5;--fg:#08130f;--muted:#4a5b58;--card:#fff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:520px;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border-radius:14px;padding:18px;margin:14px 0}
h1{font-size:1.4rem;margin:.2em 0}
label{display:block;margin:.6em 0 .2em;color:var(--muted)}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #567;font-size:1rem;background:transparent;color:inherit}
button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#08130f;font-weight:600;font-size:1rem;cursor:pointer}
button.danger{background:#d64545;color:#fff}
ul{padding-left:1.2em}
.muted{color:var(--muted);font-size:.9rem}
[hidden]{display:none}
#msg{min-height:1.5em}
</style></head>
<body><main>
<h1 data-en="Delete your ${n} account" data-id="Hapus akun ${n} Anda">Delete your ${n} account</h1>
<p class="muted" data-en="You can also do this in the app: Account → Delete account." data-id="Anda juga bisa melakukannya di aplikasi: Akun → Hapus akun.">You can also do this in the app: Account → Delete account.</p>
<div class="card">
<strong data-en="Deleted at once" data-id="Langsung dihapus">Deleted at once</strong>
<ul>
<li data-en="Your name, phone number and e-mail" data-id="Nama, nomor HP dan e-mail Anda">Your name, phone number and e-mail</li>
<li data-en="Saved cards and linked e-wallets" data-id="Kartu tersimpan dan e-wallet yang ditautkan">Saved cards and linked e-wallets</li>
<li data-en="Favourites, loyalty points, notification settings; every phone is signed out" data-id="Favorit, poin loyalitas, pengaturan notifikasi; semua ponsel keluar dari akun">Favourites, loyalty points, notification settings; every phone is signed out</li>
</ul>
<strong data-en="Kept, as the law requires" data-id="Disimpan, sesuai ketentuan hukum">Kept, as the law requires</strong>
<ul><li data-en="Charges, payments and receipts (tax records: Indonesia 10 years, Malaysia 7, Singapore 5), with no name or number on them" data-id="Pengisian, pembayaran dan struk (catatan pajak: Indonesia 10 tahun, Malaysia 7, Singapura 5), tanpa nama atau nomor">Charges, payments and receipts (tax records: Indonesia 10 years, Malaysia 7, Singapore 5), with no name or number on them</li></ul>
<p class="muted" data-en="Unpaid sessions and charges in progress must be settled first." data-id="Sesi yang belum dibayar dan pengisian yang berjalan harus diselesaikan terlebih dahulu.">Unpaid sessions and charges in progress must be settled first.</p>
</div>
<form class="card" id="f1">
<label for="phone" data-en="Phone number of the account" data-id="Nomor HP akun">Phone number of the account</label>
<input id="phone" name="phone" type="tel" autocomplete="tel" required placeholder="0812 3456 7890">
<button type="submit" data-en="Send code" data-id="Kirim kode">Send code</button>
</form>
<form class="card" id="f2" hidden>
<label for="code" data-en="The code we sent" data-id="Kode yang kami kirim">The code we sent</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="6">
<button class="danger" type="submit" data-en="Delete my account" data-id="Hapus akun saya">Delete my account</button>
</form>
<p id="msg" role="status"></p>
</main>
<script src="/d/account-delete.js"></script>
</body></html>
`;
}

export const ACCOUNT_DELETE_JS = `(function(){
var id=/^id\\b/i.test(navigator.language||'');
if(id){document.documentElement.lang='id';document.querySelectorAll('[data-id]').forEach(function(e){e.textContent=e.getAttribute('data-id');});document.title=document.querySelector('h1').textContent;}
var t=function(en,i){return id?i:en;};
var msg=document.getElementById('msg');
var tok=null;
function api(path,body){return fetch(path,{method:'POST',headers:Object.assign({'content-type':'application/json','x-driver-lang':id?'id':'en'},tok?{authorization:'Bearer '+tok}:{}),body:JSON.stringify(body||{})}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {status:r.status,body:j};});});}
function device(){if(tok)return Promise.resolve(tok);return api('/d/v1/device').then(function(r){tok=r.body.deviceToken;return tok;});}
document.getElementById('f1').addEventListener('submit',function(e){e.preventDefault();msg.textContent='';
var phone=document.getElementById('phone').value;
device().then(function(){return api('/d/v1/account/delete/start',{phone:phone});}).then(function(r){
if(r.status!==200){msg.textContent=r.body.error||t('Something went wrong. Try again.','Terjadi kesalahan. Coba lagi.');return;}
document.getElementById('f2').hidden=false;
msg.textContent=t('If this number has an account, a code is on its way to ','Jika nomor ini memiliki akun, kode sedang dikirim ke ')+(r.body.phoneMasked||'')+(r.body.devCode?' ('+r.body.devCode+')':'');});});
document.getElementById('f2').addEventListener('submit',function(e){e.preventDefault();msg.textContent='';
api('/d/v1/account/delete',{phone:document.getElementById('phone').value,code:document.getElementById('code').value}).then(function(r){
if(r.status===200){document.getElementById('f1').hidden=true;document.getElementById('f2').hidden=true;msg.textContent=t('Your account has been deleted.','Akun Anda telah dihapus.');return;}
msg.textContent=r.body.error||t('Something went wrong. Try again.','Terjadi kesalahan. Coba lagi.');});});
})();
`;
