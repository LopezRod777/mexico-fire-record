// Botón de pantalla completa para el video de demostración. Sin JavaScript el botón no aparece
// y quedan los controles propios del navegador.
const video = document.querySelector('video');
const button = document.getElementById('fullscreen');
const supported = Boolean(video.requestFullscreen || video.webkitRequestFullscreen || video.webkitEnterFullscreen);
if (supported) {
  button.hidden = false;
  button.addEventListener('click', () => {
    if (video.requestFullscreen) video.requestFullscreen().catch(() => {});
    else if (video.webkitRequestFullscreen) video.webkitRequestFullscreen();
    else video.webkitEnterFullscreen();
  });
}
