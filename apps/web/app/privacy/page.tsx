export const dynamic = 'force-static';

export default function PrivacyPage() {
  return (
    <main className="max-w-2xl mx-auto px-5 py-10 space-y-4 text-sm leading-relaxed">
      <h1 className="text-2xl font-semibold">Tenda Vault privacy</h1>
      <p>
        Tenda Vault is a private monitor for the owner&apos;s own router. It does not offer a public account,
        and it does not track people across other companies&apos; apps or websites.
      </p>
      <p>
        The phone unlocks with the owner&apos;s existing hardware passkey. The app keeps that session on the
        device. A review demonstration inside the app uses sample devices only and does not contact the router.
      </p>
      <p>
        After a real unlock, the app can register for alerts about the owner&apos;s network: a new device, an
        attack, an outage, or a download limit. Those alerts are sent by the owner&apos;s server to this phone.
        The router password, when typed, is sent once to that same server and is not stored in the app.
      </p>
      <p>There is no advertising identifier and no sale of data.</p>
    </main>
  );
}
