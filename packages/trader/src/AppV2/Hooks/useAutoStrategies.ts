import { useQuery } from '@deriv/api';

/**
 * Fetches the list of available automated trading strategies (`auto_list_strategies`).
 * This endpoint does not require authentication, so it is always enabled.
 */
export const useAutoStrategies = () => {
    const { data, isInitialLoading, error, refetch } = useQuery('auto_list_strategies', {
        options: {
            staleTime: 5 * 60 * 1000,
            cacheTime: 5 * 60 * 1000,
            retry: false,
            refetchOnWindowFocus: false,
        },
    });

    return {
        strategies: data?.auto_list_strategies?.strategies ?? [],
        is_loading: isInitialLoading,
        error: error as { code?: string; message?: string } | null,
        refetch,
    };
};

export default useAutoStrategies;
