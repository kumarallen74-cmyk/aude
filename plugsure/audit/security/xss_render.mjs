// Reproduce the EXACT esc() and the two interpolation sites from src/web/index.html
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// Attribute-context site (fleet action buttons):
const id1 = 'ATTR" onmouseover=alert(1) x="';
console.log('--- data-id attribute context ---');
console.log(`<button class="act" data-cmd="remote-start" data-id="${esc(id1)}">Start</button>`);

// Text-context site (mono cell) with the classic <img> payload:
const id2 = 'PWN"><img src=x onerror=alert(document.domain)>';
console.log('--- text (<td>) context ---');
console.log(`<td class="mono">${esc(id2)}</td>`);
