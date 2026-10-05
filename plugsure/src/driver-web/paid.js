// The payment return page's script (paid.html). A file of its own, not inline: the driver app's pages allow no inline
// script without the per-response nonce, and this page is served as a static file (v1.9.1, src/api/csp.ts).
(function(){
  try{ var t=localStorage.getItem('ps_theme'); if(t) document.documentElement.setAttribute('data-theme',t); }catch(e){}
  // The app's language (Indonesian unless the app was in English: Malaysia, Singapore, or the driver's choice).
  var en=false; try{ en=localStorage.getItem('ps_lang_now')==='en'; }catch(e){}
  var T=en?{back:'Back to PlugSure…',wait:'We are waiting for the payment provider to confirm the payment.',open:'Open PlugSure',
      cancelled:'Payment cancelled',none:'No money was taken. You can choose another method and try again.',ret:'Back to PlugSure',title:'PlugSure · Payment'}:null;
  if(T){ document.documentElement.lang='en'; document.title=T.title; document.getElementById('h').textContent=T.back; document.getElementById('p').textContent=T.wait; document.getElementById('go').textContent=T.open; }
  var q=new URLSearchParams(location.search);
  // Midtrans: transaction_status; Xendit / sandbox: status; Stripe: redirect_status (succeeded | processing | failed).
  // Anything that is not a failure resumes the payment screen.
  var st=String(q.get('status')||q.get('transaction_status')||q.get('redirect_status')||'').toLowerCase();
  // Linking an e-wallet: the app itself checks the outcome with the acquirer.
  var failed=q.get('for')!=='link'&&/cancel|deny|fail|expire/.test(st);
  if(failed){
    try{ localStorage.removeItem('ps_pending'); }catch(e){}
    document.getElementById('spin').style.display='none';
    document.getElementById('h').textContent=T?T.cancelled:'Pembayaran dibatalkan';
    document.getElementById('p').textContent=T?T.none:'Tidak ada dana yang ditarik. Anda bisa memilih metode lain dan mencoba lagi.';
    var a=document.getElementById('go'); a.textContent=T?T.ret:'Kembali ke PlugSure'; a.href='/app/';
    return;
  }
  setTimeout(function(){ location.replace('/app/#paid'); },700);
})();
