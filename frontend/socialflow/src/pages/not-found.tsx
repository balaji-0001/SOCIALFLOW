import { useEffect } from 'react';
import { Compass } from 'lucide-react';
import '@/app/app.css';

export default function NotFound() {
  useEffect(() => { document.title = 'Page not found · Socialflow'; }, []);
  return <main className="sfa-notfound">
    <div className="sfa-emptystate">
      <span className="sfa-emptystate__icon" aria-hidden="true"><Compass size={22} /></span>
      <span className="sfa-eyebrow">Error 404</span>
      <h1 className="sfa-notfound__title">Page not found</h1>
      <p>The page you’re looking for doesn’t exist or may have moved.</p>
      <div className="sfa-emptystate__actions">
        <a className="sfa-btn sfa-btn--primary sfa-btn--md" href="/dashboard">Go to dashboard</a>
        <a className="sfa-btn sfa-btn--secondary sfa-btn--md" href="/">Back to site</a>
      </div>
    </div>
  </main>;
}
