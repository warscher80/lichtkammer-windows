import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

if (location.hash === '#gputest') {
  // Messmodus (Grafikkarten-Vergleich in der CI): keine Oberfläche.
  void import('./lib/gpu/gputest').then((module) => module.runGpuTest())
} else {
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
