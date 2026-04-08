export type UserRole = 'superadmin' | 'associate' | 'builder' | 'salesperson' | 'whatsapp_manager';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  photoURL?: string;
}
