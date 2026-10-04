import '../style.css';
import { roomCodeFromPath } from '../shared/roomCode';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('#app element is missing');

const code = roomCodeFromPath(window.location.pathname);

const title = document.createElement('h1');
title.textContent = code ? `Комната ${code}` : 'Комната не найдена';
app.append(title);

const home = document.createElement('a');
home.href = '/';
home.textContent = 'На главную';
app.append(home);
