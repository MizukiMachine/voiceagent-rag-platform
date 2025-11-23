import dynamic from 'next/dynamic';

const ProfileDashboard = dynamic(() => import('./ProfileDashboard'), { ssr: false });

export default function NutritionPage() {
  return <ProfileDashboard />;
}
