import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import LessonBuilderPage from './pages/LessonBuilderPage';
import SalesFunnelPage from './pages/SalesFunnelPage';
import TwilioMessagingPage from './pages/TwilioMessagingPage';
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
            <ProtectedRoute allowedRoles={['superadmin', 'associate', 'whatsapp_manager']}>
              <AppLayout>
                <TwilioMessagingPage />
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
