import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/AppShell';
import ScrollToTop from './components/ScrollToTop';
import OverviewPage from './routes/OverviewPage';
import AccessPointsPage from './routes/AccessPointsPage';
import ApDetailPage from './routes/ApDetailPage';
import SwitchesPage from './routes/SwitchesPage';
import SwitchDetailPage from './routes/SwitchDetailPage';
import GatewayPage from './routes/GatewayPage';
import EventsPage from './routes/EventsPage';
import InvestigatePage from './routes/InvestigatePage';
import ClientsPage from './routes/ClientsPage';
import ClientDetailPage from './routes/ClientDetailPage';
import MapPage from './routes/MapPage';
import ConfigurationPage from './routes/ConfigurationPage';

export default function App() {
  return (
    <BrowserRouter basename={window.CRIBL_BASE_PATH ?? '/'}>
      <ScrollToTop />
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="/access-points" element={<AccessPointsPage />} />
          <Route path="/aps/:apName" element={<ApDetailPage />} />
          <Route path="/switches" element={<SwitchesPage />} />
          <Route path="/switches/:switchName" element={<SwitchDetailPage />} />
          <Route path="/gateway" element={<GatewayPage />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="/clients/:clientName" element={<ClientDetailPage />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/investigate" element={<InvestigatePage />} />
          <Route path="/configuration" element={<ConfigurationPage />} />
          {/* Setup and Settings used to be their own pages. Keep those URLs
              working, and never answer an unmatched path with an empty app:
              a browser left on a route that no longer exists matched nothing
              and reported "the app mounted nothing". */}
          <Route path="/setup" element={<Navigate to="/configuration?tab=alerts" replace />} />
          <Route path="/settings" element={<Navigate to="/configuration" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
