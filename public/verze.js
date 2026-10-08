/* Verze všech aplikací Famicura Kamera (hlavní aplikace, rodina, dispečink,
 * provoz): jedno místo, v hlavičce každé stránky jako „v1.0“. */
window.FAMICURA_VERZE = '3.15';
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-verze]').forEach((el) => { el.textContent = 'v' + window.FAMICURA_VERZE; });
});
