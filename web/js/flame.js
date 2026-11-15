const NS='http:' + '//www.w3.org/2000/svg';
export function flameHeight(frp) { return 10 + 18 * Math.min(1, Math.log1p(Math.max(0, frp ?? 0)) / Math.log1p(15)); }
export function ensureFlameDefs() {
  if(document.getElementById('flame'))return;
  const svg=document.createElementNS(NS,'svg');svg.setAttribute('class','flame-defs');svg.setAttribute('aria-hidden','true');
  const defs=document.createElementNS(NS,'defs'),flame=document.createElementNS(NS,'g');flame.setAttribute('id','flame');
  for(const [id,d] of [['flame-body','M10 0C11.2 6 18 10.5 18 18.2C18 24.2 14.5 28 10 28C5.5 28 2 24.2 2 18.2C2 14.2 4.1 11.6 6.2 9.4C6.3 12.4 7.6 13.8 8.9 14C7.9 9 8.4 4.4 10 0Z'],['flame-core','M10 15C11 18 14 20 14 23.2C14 25.6 12.3 27 10 27C7.7 27 6 25.6 6 23.2C6 20.6 8.6 19 10 15Z']]){const path=document.createElementNS(NS,'path');path.setAttribute('id',id);path.setAttribute('d',d);flame.append(path);}
  defs.append(flame);svg.append(defs);document.body.prepend(svg);
}
