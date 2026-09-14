import { useEffect, useState } from 'react';

export function useQuery<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{
    loading: boolean;
    data: T | null;
    error: string;
  }>({ loading: true, data: null, error: '' });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, data: null, error: '' });
    void load(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ loading: false, data, error: '' });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            loading: false,
            data: null,
            error:
              error instanceof Error
                ? error.message
                : 'Unable to load this page. Please try again.',
          });
      });
    return () => controller.abort();
  }, [load, revision]);
  return { ...state, reload: () => setRevision((value) => value + 1) };
}
