import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
// このエントリから読むことで、ビルド後のバンドルに CSS が乗る（#71）
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root が見つからない')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
