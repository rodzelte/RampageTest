export const navigation = [
  { path: '/overview', label: 'Overview', icon: 'overview', ownerOnly: false },
  { path: '/lobbies', label: 'Lobbies', icon: 'lobbies', ownerOnly: false },
  { path: '/rampage', label: 'Rampage', icon: 'rampage', ownerOnly: false },
  { path: '/payments', label: 'Payments', icon: 'payments', ownerOnly: false },
  { path: '/cashouts', label: 'Cashouts', icon: 'cashouts', ownerOnly: false },
  { path: '/members', label: 'Members', icon: 'members', ownerOnly: true },
  { path: '/admins', label: 'Admins', icon: 'admins', ownerOnly: true },
  { path: '/audit', label: 'Audit Logs', icon: 'audit', ownerOnly: true },
  { path: '/autopost', label: 'Autopost', icon: 'autopost', ownerOnly: false },
  { path: '/settings', label: 'Settings', icon: 'settings', ownerOnly: true },
] as const;
export function canAccessRoute(role: 'OWNER' | 'ADMIN', path: string) {
  const route = navigation.find(
    (item) => item.path === path || path.startsWith(`${item.path}/`),
  );
  return Boolean(route && (!route.ownerOnly || role === 'OWNER'));
}
