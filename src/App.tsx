import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AppShell from './components/AppShell';
import SettingsPage from './routes/SettingsPage';
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

export default function App() {
  return (
    <BrowserRouter basename={window.CRIBL_BASE_PATH ?? '/'}>
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
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
