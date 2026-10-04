import '../style.css';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('#app element is missing');

const title = document.createElement('h1');
title.textContent = 'Arena';
app.append(title);
