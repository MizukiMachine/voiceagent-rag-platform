import ProfileDashboard from '../ProfileDashboard';

export default function NutritionByTagPage({ params }: { params: { clientTag: string } }) {
  const clientTag = params.clientTag;
  return <ProfileDashboard clientTag={clientTag} />;
}
