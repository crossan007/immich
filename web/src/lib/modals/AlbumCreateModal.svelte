<script lang="ts">
  import { createAlbum } from '$lib/utils/album-utils';
  import { handleError } from '$lib/utils/handle-error';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { Button, Field, Input, Modal, ModalBody, ModalFooter, Switch, Textarea } from '@immich/ui';
  import { mdiPlusBoxOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    onClose: (album?: AlbumResponseDto) => void;
    assetIds?: string[];
  };

  let { onClose, assetIds }: Props = $props();

  let albumName = $state('');
  let description = $state('');
  let hideFromTimeline = $state(false);
  let isExclusive = $state(false);
  let isSubmitting = $state(false);

  const handleSubmit = async (event: Event) => {
    event.preventDefault();

    if (!albumName.trim()) {
      return;
    }

    isSubmitting = true;

    try {
      const newAlbum = await createAlbum(albumName.trim(), assetIds, {
        description: description.trim() || undefined,
        hideFromTimeline,
        isExclusive,
      });

      if (newAlbum) {
        onClose(newAlbum);
      }
    } catch (error) {
      handleError(error, $t('errors.failed_to_create_album'));
    } finally {
      isSubmitting = false;
    }
  };
</script>

<Modal icon={mdiPlusBoxOutline} title={$t('create_album')} size="medium" {onClose}>
  <ModalBody>
    <form onsubmit={handleSubmit} autocomplete="off" id="create-album-form">
      <div class="flex flex-col gap-4 p-4">
        <Field label={$t('name')} required>
          <Input bind:value={albumName} placeholder={$t('album_name')} />
        </Field>

        <Field label={$t('description')}>
          <Textarea bind:value={description} placeholder={$t('album_description_optional')} />
        </Field>

        <div class="flex flex-col gap-3 border-t pt-4">
          <h3 class="text-sm font-medium text-gray-700 dark:text-gray-300">{$t('advanced_options')}</h3>

          <div class="flex flex-col gap-3">
            <div>
              <Switch bind:checked={hideFromTimeline}>
                {$t('hide_from_timeline')}
              </Switch>
              <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {$t('hide_photos_in_album_from_timeline')}
              </p>
            </div>

            <div>
              <Switch bind:checked={isExclusive}>
                {$t('exclusive_album')}
              </Switch>
              <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {$t('remove_photos_from_other_albums')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </form>
  </ModalBody>

  <ModalFooter>
    <div class="flex gap-2 w-full">
      <Button shape="round" color="secondary" fullWidth onclick={() => onClose()}>
        {$t('cancel')}
      </Button>
      <Button
        shape="round"
        type="submit"
        fullWidth
        disabled={isSubmitting || !albumName.trim()}
        form="create-album-form"
      >
        {$t('create')}
      </Button>
    </div>
  </ModalFooter>
</Modal>
