declare const __DASHBOARD_CONFIG__: {
  appName: string;
  timezone: string;
  environment: string;
};
export const dashboardConfig =
  typeof __DASHBOARD_CONFIG__ === 'undefined'
    ? { appName: 'Rampage', timezone: 'Asia/Manila', environment: 'test' }
    : __DASHBOARD_CONFIG__;
