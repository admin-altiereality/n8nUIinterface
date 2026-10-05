import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import LessonBuilderPage from './pages/LessonBuilderPage';
import SalesFunnelPage from './pages/SalesFunnelPage';
import SalesHomePage from './pages/SalesHomePage';
import PipelinePage from './pages/PipelinePage';
import TwilioMessagingPage from './pages/TwilioMessagingPage';
import OpsDashboardPage from './pages/OpsDashboardPage';
import LeadTimelinePage from './pages/LeadTimelinePage';
import SocialAdsPage from './pages/SocialAdsPage';
import AdminPage from './pages/AdminPage';
import SchoolPage from './pages/SchoolPage';
import TeamPage from './pages/TeamPage';
import CustomersPage from './pages/CustomersPage';
import GuidePage from './pages/GuidePage';
import LoginPage from './pages/LoginPage';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AppLayout } from './components/layout/AppLayout';

const App: React.FC = () => {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute allowedRoles={['superadmin', 'associate', 'builder']}>
              <AppLayout>
                <LessonBuilderPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute allowedRoles={['superadmin', 'associate', 'salesperson', 'whatsapp_manager']}>
              <AppLayout>
                <OpsDashboardPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/ops/leads/:id"
          element={
            <ProtectedRoute allowedRoles={['superadmin', 'associate', 'salesperson', 'whatsapp_manager']}>
              <AppLayout>
                <LeadTimelinePage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/sales"
          element={
            <ProtectedRoute allowedRoles={['superadmin', 'associate', 'salesperson']}>
              <AppLayout>
                <SalesHomePage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/pipeline"
          element={
            <ProtectedRoute allowedRoles={['superadmin', 'associate', 'salesperson']}>
              <AppLayout>
                <PipelinePage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/sales-funnel"
          element={
            <ProtectedRoute allowedRoles={['superadmin', 'associate', 'salesperson']}>
              <AppLayout>
                <SalesFunnelPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/twilio-messaging"
          element={
            <ProtectedRoute allowedRoles={['superadmin', 'associate', 'salesperson', 'whatsapp_manager']}>
              <AppLayout>
                <TwilioMessagingPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/social"
          element={
            <ProtectedRoute allowedRoles={['superadmin', 'associate']}>
              <AppLayout>
                <SocialAdsPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/schools/:orgKey"
          element={
            <ProtectedRoute allowedRoles={['superadmin', 'associate', 'salesperson']}>
              <AppLayout>
                <SchoolPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/customers"
          element={
            <ProtectedRoute allowedRoles={['superadmin', 'associate', 'salesperson']}>
              <AppLayout>
                <CustomersPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/team"
          element={
            <ProtectedRoute allowedRoles={['superadmin', 'associate', 'salesperson']}>
              <AppLayout>
                <TeamPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin"
          element={
            <ProtectedRoute allowedRoles={['superadmin']}>
              <AppLayout>
                <AdminPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/guide"
          element={
            <ProtectedRoute allowedRoles={['superadmin', 'associate', 'salesperson', 'whatsapp_manager', 'builder']}>
              <AppLayout>
                <GuidePage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
};

export default App;
