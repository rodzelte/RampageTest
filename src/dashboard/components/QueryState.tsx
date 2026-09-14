export function QueryState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string;
  retry: () => void;
}) {
  if (loading)
    return (
      <div className="query-state" role="status">
        Loading current data…
      </div>
    );
  if (error)
    return (
      <div className="query-state error" role="alert">
        <p>{error}</p>
        <button onClick={retry}>Try again</button>
      </div>
    );
  return null;
}
export function Pagination({
  page,
  count,
  pageSize,
  onPage,
}: {
  page: number;
  count: number;
  pageSize: number;
  onPage: (value: number) => void;
}) {
  return (
    <div className="pagination">
      <span>
        {count === 0
          ? '0 records'
          : `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, count)} of ${count}`}
      </span>
      <div>
        <button disabled={page === 0} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <button
          disabled={(page + 1) * pageSize >= count}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
