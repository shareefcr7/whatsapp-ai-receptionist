import { Compass } from 'lucide-react';
import { Link } from 'react-router';
import { Card, EmptyState } from '../components/ui';

export function NotFound() {
  return (
    <Card>
      <EmptyState icon={Compass} title="Page not found">
        <Link to="/" className="font-medium text-brand-700 hover:underline">
          Back to Overview
        </Link>
      </EmptyState>
    </Card>
  );
}
