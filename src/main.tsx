import { render } from 'preact';
import { App } from './ui/app';

const root = document.getElementById('golf-buddy');
if (root) render(<App />, root);
