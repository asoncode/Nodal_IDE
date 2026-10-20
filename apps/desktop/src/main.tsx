import React from 'react';
import { createRoot } from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import App from './App.js';
import '@xyflow/react/dist/style.css';
import './styles.css';

self.MonacoEnvironment = { getWorker: (_moduleId, label) => label === 'json' ? new JsonWorker() : ['typescript', 'javascript'].includes(label) ? new TsWorker() : new EditorWorker() };
loader.config({ monaco });
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
