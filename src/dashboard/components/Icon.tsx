const paths: Record<string, string> = {
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  lobbies: 'M4 4h16v5H4z M4 15h6v5H4z M14 15h6v5h-6z M12 9v3 M7 15v-3h10v3',
  rampage: 'm13 2-9 12h7l-1 8 10-13h-7z',
  payments: 'M3 6h18v13H3z M3 10h18 M7 15h4',
  cashouts: 'M4 9v11h16V9 M12 15V3 M8 7l4-4 4 4',
  members:
    'M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M2 21v-3a6 6 0 0 1 12 0v3 M17 4a4 4 0 0 1 0 8 M18 15a5 5 0 0 1 4 5',
  admins: 'm12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6z m-4 10 3 3 5-6',
  audit: 'M5 3h14v18H5z M8 7h8 M8 12h8 M8 17h5',
  autopost: 'M3 10v5h5l11 5V4L8 10z M8 15l2 6',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
};
export function Icon({ name }: { name: string }) {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.overview} />
    </svg>
  );
}
