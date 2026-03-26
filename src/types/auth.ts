export type UserRole = 'superadmin' | 'builder' | 'salesperson' | 'whatsapp_manager';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export const MOCK_USERS: User[] = [
  { id: '1', email: 'admin@learnxr.com', name: 'Super Admin', role: 'superadmin' },
  { id: '2', email: 'builder@learnxr.com', name: 'Lead Builder', role: 'builder' },
  { id: '3', email: 'sales@learnxr.com', name: 'Sales Lead', role: 'salesperson' },
  { id: '4', email: 'whatsapp@learnxr.com', name: 'Chat Manager', role: 'whatsapp_manager' },
];
