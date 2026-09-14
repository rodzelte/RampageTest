import { useCallback, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useQuery } from '../hooks/useQuery';
import {
  emptyPaymentFilters,
  loadPayments,
  PAGE_SIZE,
  resolveTopupReview,
  type TopupWithMember,
} from '../lib/data';
import { Pagination, QueryState } from '../components/QueryState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { formatDate } from '../lib/dates';
import { formatPhp, parsePhpToCentavos } from '../../shared/money';
import { topupStatusSchema } from '../../shared/models';
import { Icon } from '../components/Icon';

type Review = { topup: TopupWithMember; decision: 'APPROVE' | 'REJECT' };

export function PaymentsPage() {
  const { client, staff } = useAuth();
  const [draft, setDraft] = useState(emptyPaymentFilters);
  const [filters, setFilters] = useState(emptyPaymentFilters);
  const [page, setPage] = useState(0);
  const [review, setReview] = useState<Review | null>(null);
  const [reason, setReason] = useState('');
  const [creditAmount, setCreditAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState('');
  const query = useQuery(
    useCallback(
      (signal: AbortSignal) => loadPayments(client, filters, page, signal),
      [client, filters, page],
    ),
  );
  function apply(event: FormEvent) {
    event.preventDefault();
    setPage(0);
    setFilters({ ...draft });
  }
  function openReview(topup: TopupWithMember, decision: 'APPROVE' | 'REJECT') {
    setReview({ topup, decision });
    setReason('');
    setCreditAmount(
      decision === 'APPROVE' && topup.provider_paid_amount_centavos !== null
        ? (topup.provider_paid_amount_centavos / 100).toFixed(2)
        : '',
    );
    setMutationError('');
  }
  async function saveReview() {
    if (!review) return;
    setSaving(true);
    setMutationError('');
    try {
      const amount =
        review.decision === 'APPROVE' ? parsePhpToCentavos(creditAmount) : null;
      if (
        review.decision === 'APPROVE' &&
        amount !== review.topup.provider_paid_amount_centavos
      )
        throw new Error(
          'Credit amount must exactly match the provider-paid amount.',
        );
      await resolveTopupReview(client, {
        topupId: review.topup.id,
        decision: review.decision,
        reason,
        creditAmountCentavos: amount,
      });
      setReview(null);
      query.reload();
    } catch (error) {
      setMutationError(
        error instanceof Error
          ? error.message
          : 'Unable to resolve this review.',
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div className="section-intro">
        <p>Verified payment records and review exceptions.</p>
        <span className="badge">OWNER / ADMIN</span>
      </div>
      <section className="panel">
        <form className="payment-filters toolbar" onSubmit={apply}>
          <label>
            Date
            <input
              type="date"
              value={draft.date}
              onChange={(event) =>
                setDraft({ ...draft, date: event.target.value })
              }
            />
          </label>
          <label>
            Status
            <select
              value={draft.status}
              onChange={(event) =>
                setDraft({ ...draft, status: event.target.value })
              }
            >
              <option value="">All statuses</option>
              {topupStatusSchema.options.map((status) => (
                <option key={status}>{status}</option>
              ))}
            </select>
          </label>
          <label>
            Discord user
            <input
              aria-label="Discord user"
              value={draft.discord}
              onChange={(event) =>
                setDraft({ ...draft, discord: event.target.value })
              }
              placeholder="Discord ID"
            />
          </label>
          <label>
            Provider reference
            <input
              value={draft.reference}
              onChange={(event) =>
                setDraft({ ...draft, reference: event.target.value })
              }
              placeholder="Reference"
            />
          </label>
          <button className="primary" type="submit">
            Apply filters
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(emptyPaymentFilters);
              setFilters(emptyPaymentFilters);
              setPage(0);
              query.reload();
            }}
          >
            Reset
          </button>
        </form>
        <QueryState
          loading={query.loading}
          error={query.error}
          retry={query.reload}
        />
        {query.data && (
          <>
            {query.data.rows.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">
                  <Icon name="payments" />
                </div>
                <h2>No payments found.</h2>
                <p>
                  Top-up requests will appear here without exposing them
                  publicly in Discord.
                </p>
              </div>
            ) : (
              <div className="table-scroll">
                <table className="payments-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Discord member</th>
                      <th>Discord ID</th>
                      <th className="amount">Requested</th>
                      <th className="amount">Provider paid</th>
                      <th>Provider</th>
                      <th>Reference</th>
                      <th>Status</th>
                      <th>Created</th>
                      <th>Expires</th>
                      <th>Paid</th>
                      <th>Credited</th>
                      {staff?.role === 'OWNER' && <th>Review</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.rows.map((topup) => {
                      const reviewable =
                        topup.status === 'LATE_PAID_REVIEW' ||
                        topup.status === 'AMOUNT_MISMATCH_REVIEW';
                      return (
                        <tr key={topup.id}>
                          <td className="date">
                            {formatDate(topup.created_at)}
                          </td>
                          <td>
                            {topup.members.display_name ??
                              topup.members.discord_username ??
                              '—'}
                          </td>
                          <td className="mono">
                            {topup.members.discord_user_id}
                          </td>
                          <td className="amount">
                            {formatPhp(topup.amount_centavos)}
                          </td>
                          <td className="amount">
                            {topup.provider_paid_amount_centavos === null
                              ? '—'
                              : formatPhp(topup.provider_paid_amount_centavos)}
                          </td>
                          <td>
                            <span className="badge">{topup.provider}</span>
                          </td>
                          <td className="mono">
                            {topup.provider_reference ?? '—'}
                          </td>
                          <td>
                            <span
                              className={`badge ${reviewable ? 'danger' : topup.status === 'PAID' || topup.review_resolution === 'APPROVED_CREDIT' ? 'active' : ''}`}
                            >
                              {topup.status.replaceAll('_', ' ')}
                            </span>
                          </td>
                          <td className="date">
                            {formatDate(topup.created_at)}
                          </td>
                          <td className="date">
                            {formatDate(topup.expires_at)}
                          </td>
                          <td className="date">
                            {topup.provider_paid_at
                              ? formatDate(topup.provider_paid_at)
                              : '—'}
                          </td>
                          <td className="date">
                            {topup.credited_at
                              ? formatDate(topup.credited_at)
                              : '—'}
                          </td>
                          {staff?.role === 'OWNER' && (
                            <td>
                              {reviewable ? (
                                <div className="row-actions">
                                  <button
                                    className="primary"
                                    onClick={() => openReview(topup, 'APPROVE')}
                                  >
                                    Approve credit
                                  </button>
                                  <button
                                    onClick={() => openReview(topup, 'REJECT')}
                                  >
                                    Reject credit
                                  </button>
                                </div>
                              ) : (
                                '—'
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination
              page={page}
              count={query.data.count}
              pageSize={PAGE_SIZE}
              onPage={setPage}
            />
          </>
        )}
      </section>
      <p className="page-footnote">
        ADMIN access is read-only. Only credited TOPUP ledger entries count as
        Cash In.
      </p>
      {review && (
        <ConfirmDialog
          title={`${review.decision === 'APPROVE' ? 'Approve' : 'Reject'} top-up review`}
          confirmLabel={
            review.decision === 'APPROVE' ? 'Approve credit' : 'Reject credit'
          }
          busy={saving}
          onConfirm={() => void saveReview()}
          onClose={() => setReview(null)}
        >
          <div className="review-summary">
            <p>
              Requested Amount
              <strong>{formatPhp(review.topup.amount_centavos)}</strong>
            </p>
            <p>
              Provider Paid Amount
              <strong>
                {review.topup.provider_paid_amount_centavos === null
                  ? 'Unavailable'
                  : formatPhp(review.topup.provider_paid_amount_centavos)}
              </strong>
            </p>
          </div>
          {review.decision === 'APPROVE' && (
            <label>
              Credit amount (PHP)
              <input
                aria-label="Credit amount"
                value={creditAmount}
                onChange={(event) => setCreditAmount(event.target.value)}
                required
              />
            </label>
          )}
          <label>
            Reason
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              maxLength={500}
            />
          </label>
          {mutationError && (
            <p className="form-error" role="alert">
              {mutationError}
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
