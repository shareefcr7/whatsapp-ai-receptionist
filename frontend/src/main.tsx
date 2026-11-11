import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import './index.css';
import { AuthGate } from './lib/auth';
import { Appointments, Conversations, Leads } from './pages/ListPages';
import { BusinessInformation } from './pages/BusinessInformation';
import { NotFound } from './pages/NotFound';
import { Overview } from './pages/Overview';
import { Services } from './pages/Services';
import { Settings } from './pages/Settings';
import { UsageCosts } from './pages/UsageCosts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<AuthGate />}>
          <Route path="login" element={<Navigate to="/" replace />} />
          <Route element={<Layout />}>
            <Route index element={<Overview />} />
            <Route path="conversations" element={<Conversations />} />
            <Route path="leads" element={<Leads />} />
            <Route path="appointments" element={<Appointments />} />
            <Route path="business-information" element={<BusinessInformation />} />
            <Route path="services" element={<Services />} />
            <Route path="usage-costs" element={<UsageCosts />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
