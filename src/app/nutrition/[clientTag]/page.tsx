import ProfileDashboard from '../ProfileDashboard';

export default async function NutritionByTagPage({
  params,
}: {
  params: Promise<{ clientTag: string }>;
}) {
  const { clientTag } = await params;
  return <ProfileDashboard clientTag={clientTag} />;
}
