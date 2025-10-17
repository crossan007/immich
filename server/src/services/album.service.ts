import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AddUsersDto,
  AlbumInfoDto,
  AlbumResponseDto,
  AlbumsAddAssetsDto,
  AlbumsAddAssetsResponseDto,
  AlbumStatisticsResponseDto,
  CreateAlbumDto,
  GetAlbumsDto,
  mapAlbum,
  MapAlbumDto,
  mapAlbumWithAssets,
  mapAlbumWithoutAssets,
  UpdateAlbumDto,
  UpdateAlbumUserDto,
} from 'src/dtos/album.dto';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { AssetVisibility, Permission } from 'src/enum';
import { AlbumAssetCount, AlbumInfoOptions } from 'src/repositories/album.repository';
import { BaseService } from 'src/services/base.service';
import { addAssets, removeAssets } from 'src/utils/asset.util';
import { getPreferences } from 'src/utils/preferences';

@Injectable()
export class AlbumService extends BaseService {
  async getStatistics(auth: AuthDto): Promise<AlbumStatisticsResponseDto> {
    const [owned, shared, notShared] = await Promise.all([
      this.albumRepository.getOwned(auth.user.id),
      this.albumRepository.getShared(auth.user.id),
      this.albumRepository.getNotShared(auth.user.id),
    ]);

    return {
      owned: owned.length,
      shared: shared.length,
      notShared: notShared.length,
    };
  }

  async getAll({ user: { id: ownerId } }: AuthDto, { assetId, shared }: GetAlbumsDto): Promise<AlbumResponseDto[]> {
    await this.albumRepository.updateThumbnails();

    let albums: MapAlbumDto[];
    if (assetId) {
      albums = await this.albumRepository.getByAssetId(ownerId, assetId);
    } else if (shared === true) {
      albums = await this.albumRepository.getShared(ownerId);
    } else if (shared === false) {
      albums = await this.albumRepository.getNotShared(ownerId);
    } else {
      albums = await this.albumRepository.getOwned(ownerId);
    }

    // Get asset count for each album. Then map the result to an object:
    // { [albumId]: assetCount }
    const results = await this.albumRepository.getMetadataForIds(albums.map((album) => album.id));
    const albumMetadata: Record<string, AlbumAssetCount> = {};
    for (const metadata of results) {
      albumMetadata[metadata.albumId] = metadata;
    }

    return albums.map((album) => ({
      ...mapAlbumWithoutAssets(album),
      sharedLinks: undefined,
      startDate: albumMetadata[album.id]?.startDate ?? undefined,
      endDate: albumMetadata[album.id]?.endDate ?? undefined,
      assetCount: albumMetadata[album.id]?.assetCount ?? 0,
      // lastModifiedAssetTimestamp is only used in mobile app, please remove if not need
      lastModifiedAssetTimestamp: albumMetadata[album.id]?.lastModifiedAssetTimestamp ?? undefined,
    }));
  }

  async get(auth: AuthDto, id: string, dto: AlbumInfoDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    await this.albumRepository.updateThumbnails();
    const withAssets = dto.withoutAssets === undefined ? true : !dto.withoutAssets;
    const album = await this.findOrFail(id, { withAssets });
    const [albumMetadataForIds] = await this.albumRepository.getMetadataForIds([album.id]);

    const hasSharedUsers = album.albumUsers && album.albumUsers.length > 0;
    const hasSharedLink = album.sharedLinks && album.sharedLinks.length > 0;
    const isShared = hasSharedUsers || hasSharedLink;

    return {
      ...mapAlbum(album, withAssets, auth),
      startDate: albumMetadataForIds?.startDate ?? undefined,
      endDate: albumMetadataForIds?.endDate ?? undefined,
      assetCount: albumMetadataForIds?.assetCount ?? 0,
      lastModifiedAssetTimestamp: albumMetadataForIds?.lastModifiedAssetTimestamp ?? undefined,
      contributorCounts: isShared ? await this.albumRepository.getContributorCounts(album.id) : undefined,
    };
  }

  async create(auth: AuthDto, dto: CreateAlbumDto): Promise<AlbumResponseDto> {
    const albumUsers = dto.albumUsers || [];

    for (const { userId } of albumUsers) {
      const exists = await this.userRepository.get(userId, {});
      if (!exists) {
        throw new BadRequestException('User not found');
      }

      if (userId == auth.user.id) {
        throw new BadRequestException('Cannot share album with owner');
      }
    }

    const allowedAssetIdsSet = await this.checkAccess({
      auth,
      permission: Permission.AssetShare,
      ids: dto.assetIds || [],
    });
    const assetIds = [...allowedAssetIdsSet].map((id) => id);

    const userMetadata = await this.userRepository.getMetadata(auth.user.id);

    const album = await this.albumRepository.create(
      {
        ownerId: auth.user.id,
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: assetIds[0] || null,
        order: getPreferences(userMetadata).albums.defaultAssetOrder,
        hideFromTimeline: dto.hideFromTimeline || false,
        isExclusive: dto.isExclusive || false,
      },
      assetIds,
      albumUsers,
    );

    // Apply album triggers if assets were added during creation
    if (assetIds.length > 0) {
      await this.applyAlbumTriggers(auth, album, assetIds);
    }

    for (const { userId } of albumUsers) {
      await this.eventRepository.emit('AlbumInvite', { id: album.id, userId });
    }

    return mapAlbumWithAssets(album);
  }

  async update(auth: AuthDto, id: string, dto: UpdateAlbumDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });

    const album = await this.findOrFail(id, { withAssets: true });

    if (dto.albumThumbnailAssetId) {
      const results = await this.albumRepository.getAssetIds(id, [dto.albumThumbnailAssetId]);
      if (results.size === 0) {
        throw new BadRequestException('Invalid album thumbnail');
      }
    }

    // Track if we need to apply property change triggers
    const hideFromTimelineChanged = dto.hideFromTimeline !== undefined && dto.hideFromTimeline !== album.hideFromTimeline;
    const isExclusiveChanged = dto.isExclusive !== undefined && dto.isExclusive !== album.isExclusive;
    
    const updatedAlbum = await this.albumRepository.update(album.id, {
      id: album.id,
      albumName: dto.albumName,
      description: dto.description,
      albumThumbnailAssetId: dto.albumThumbnailAssetId,
      isActivityEnabled: dto.isActivityEnabled,
      order: dto.order,
      hideFromTimeline: dto.hideFromTimeline,
      isExclusive: dto.isExclusive,
    });

    // Apply property change triggers if needed
    if (hideFromTimelineChanged || isExclusiveChanged) {
      const assetIds = new Set<string>((album.assets??[]).map((asset) => asset.id));
      if (assetIds.size > 0) {
        await this.applyPropertyChangeTriggers(auth, album, updatedAlbum, assetIds);
      }
    }

    return mapAlbumWithoutAssets({ ...updatedAlbum, assets: album.assets });
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumDelete, ids: [id] });
    await this.albumRepository.delete(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    const album = await this.findOrFail(id, { withAssets: false });
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });

    const results = await addAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids },
    );

    const successfulAssetIds = results.filter(({ success }) => success).map(({ id }) => id);
    
    if (successfulAssetIds.length > 0) {
      // Apply triggers for the new album features
      await this.applyAlbumTriggers(auth, album, successfulAssetIds);

      await this.albumRepository.update(id, {
        id,
        updatedAt: new Date(),
        albumThumbnailAssetId: album.albumThumbnailAssetId ?? successfulAssetIds[0],
      });

      const allUsersExceptUs = [...album.albumUsers.map(({ user }) => user.id), album.owner.id].filter(
        (userId) => userId !== auth.user.id,
      );

      for (const recipientId of allUsersExceptUs) {
        await this.eventRepository.emit('AlbumUpdate', { id, recipientId });
      }
    }

    return results;
  }

  async addAssetsToAlbums(auth: AuthDto, dto: AlbumsAddAssetsDto): Promise<AlbumsAddAssetsResponseDto> {
    const results: AlbumsAddAssetsResponseDto = {
      success: false,
      error: BulkIdErrorReason.DUPLICATE,
    };

    const allowedAlbumIds = await this.checkAccess({
      auth,
      permission: Permission.AlbumAssetCreate,
      ids: dto.albumIds,
    });
    if (allowedAlbumIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const allowedAssetIds = await this.checkAccess({ auth, permission: Permission.AssetShare, ids: dto.assetIds });
    if (allowedAssetIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const albumAssetValues: { albumsId: string; assetsId: string }[] = [];
    const events: { id: string; recipients: string[] }[] = [];
    for (const albumId of allowedAlbumIds) {
      const existingAssetIds = await this.albumRepository.getAssetIds(albumId, [...allowedAssetIds]);
      const notPresentAssetIds = [...allowedAssetIds].filter((id) => !existingAssetIds.has(id));
      if (notPresentAssetIds.length === 0) {
        continue;
      }
      const album = await this.findOrFail(albumId, { withAssets: false });
      results.error = undefined;
      results.success = true;

      for (const assetId of notPresentAssetIds) {
        albumAssetValues.push({ albumsId: albumId, assetsId: assetId });
      }
      await this.albumRepository.update(albumId, {
        id: albumId,
        updatedAt: new Date(),
        albumThumbnailAssetId: album.albumThumbnailAssetId ?? notPresentAssetIds[0],
      });
      const allUsersExceptUs = [...album.albumUsers.map(({ user }) => user.id), album.owner.id].filter(
        (userId) => userId !== auth.user.id,
      );
      events.push({ id: albumId, recipients: allUsersExceptUs });
    }

    await this.albumRepository.addAssetIdsToAlbums(albumAssetValues);
    
    // Apply album triggers for each album that had assets added
    for (const albumId of allowedAlbumIds) {
      const album = await this.findOrFail(albumId, { withAssets: false });
      const albumAssetIds = albumAssetValues
        .filter(({ albumsId }) => albumsId === albumId)
        .map(({ assetsId }) => assetsId);
      
      if (albumAssetIds.length > 0) {
        await this.applyAlbumTriggers(auth, album, albumAssetIds);
      }
    }
    
    for (const event of events) {
      for (const recipientId of event.recipients) {
        await this.eventRepository.emit('AlbumUpdate', { id: event.id, recipientId });
      }
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetDelete, ids: [id] });

    const album = await this.findOrFail(id, { withAssets: false });
    const results = await removeAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids, canAlwaysRemove: Permission.AlbumDelete },
    );

    const removedIds = results.filter(({ success }) => success).map(({ id }) => id);
    
    // Apply reverse album triggers when assets are removed
    if (removedIds.length > 0) {
      await this.applyRemovalTriggers(auth, album, removedIds);
    }
    
    if (removedIds.length > 0 && album.albumThumbnailAssetId && removedIds.includes(album.albumThumbnailAssetId)) {
      await this.albumRepository.updateThumbnails();
    }

    return results;
  }

  async addUsers(auth: AuthDto, id: string, { albumUsers }: AddUsersDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, { withAssets: false });

    for (const { userId, role } of albumUsers) {
      if (album.ownerId === userId) {
        throw new BadRequestException('Cannot be shared with owner');
      }

      const exists = album.albumUsers.find(({ user: { id } }) => id === userId);
      if (exists) {
        throw new BadRequestException('User already added');
      }

      const user = await this.userRepository.get(userId, {});
      if (!user) {
        throw new BadRequestException('User not found');
      }

      await this.albumUserRepository.create({ usersId: userId, albumsId: id, role });
      await this.eventRepository.emit('AlbumInvite', { id, userId });
    }

    return this.findOrFail(id, { withAssets: true }).then(mapAlbumWithoutAssets);
  }

  async removeUser(auth: AuthDto, id: string, userId: string | 'me'): Promise<void> {
    if (userId === 'me') {
      userId = auth.user.id;
    }

    const album = await this.findOrFail(id, { withAssets: false });

    if (album.ownerId === userId) {
      throw new BadRequestException('Cannot remove album owner');
    }

    const exists = album.albumUsers.find(({ user: { id } }) => id === userId);
    if (!exists) {
      throw new BadRequestException('Album not shared with user');
    }

    // non-admin can remove themselves
    if (auth.user.id !== userId) {
      await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
    }

    await this.albumUserRepository.delete({ albumsId: id, usersId: userId });
  }

  async updateUser(auth: AuthDto, id: string, userId: string, dto: UpdateAlbumUserDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
    await this.albumUserRepository.update({ albumsId: id, usersId: userId }, { role: dto.role });
  }

  /**
   * Applies reverse album triggers when assets are removed from albums
   * Handles restoring visibility for "Hide from Timeline" feature
   */
  private async applyRemovalTriggers(auth: AuthDto, album: MapAlbumDto, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    // Handle "Hide from Timeline" feature - restore visibility if no other hiding albums
    if (album.hideFromTimeline) {
      // For each removed asset, check if it's still in other albums with hideFromTimeline
      for (const assetId of assetIds) {
        const otherAlbumsWithAsset = await this.albumRepository.getByAssetId(auth.user.id, assetId);
        const stillHiddenByOtherAlbum = otherAlbumsWithAsset.some(
          (otherAlbum) => otherAlbum.id !== album.id && otherAlbum.hideFromTimeline
        );
        
        // Only restore to timeline if not hidden by any other album
        if (!stillHiddenByOtherAlbum) {
          await this.assetRepository.updateAll([assetId], {
            visibility: AssetVisibility.Timeline,
          });
        }
      }
    }
  }

  /**
   * Applies album-specific triggers when assets are added to albums
   * Handles "Hide from Timeline" and "Exclusive Album" features
   */
  private async applyAlbumTriggers(auth: AuthDto, album: MapAlbumDto, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    // Handle "Hide from Timeline" feature
    if (album.hideFromTimeline) {
      // Set assets to AlbumHidden visibility to exclude them from main timeline
      await this.assetRepository.updateAll(assetIds, {
        visibility: AssetVisibility.AlbumHidden,
      });
    }

    // Handle "Exclusive Album" feature  
    if (album.isExclusive) {
      // Remove assets from all other albums
      // For each asset, find all albums they belong to and remove them from all except current album
      for (const assetId of assetIds) {
        const albumsWithAsset = await this.albumRepository.getByAssetId(auth.user.id, assetId);
        for (const otherAlbum of albumsWithAsset) {
          if (otherAlbum.id !== album.id) {
            await this.albumRepository.removeAssetIds(otherAlbum.id, [assetId]);
          }
        }
      }
    }
  }

  /**
   * Applies triggers when album properties themselves are changed
   * Handles transitioning assets when hideFromTimeline or isExclusive properties change
   */
  private async applyPropertyChangeTriggers(
    auth: AuthDto, 
    oldAlbum: MapAlbumDto, 
    newAlbum: MapAlbumDto, 
    assetIds: Set<string>
  ): Promise<void> {
    if (assetIds.size === 0) {
      return;
    }

    // Handle "Hide from Timeline" property changes
    await this.handleHideFromTimelinePropertyChange(auth, oldAlbum, newAlbum, assetIds);
    
    // Handle "Exclusive Album" property changes
    await this.handleExclusivePropertyChange(auth, oldAlbum, newAlbum, assetIds);
  }

  /**
   * Handles changes to the hideFromTimeline property
   */
  private async handleHideFromTimelinePropertyChange(
    auth: AuthDto,
    oldAlbum: MapAlbumDto,
    newAlbum: MapAlbumDto,
    assetIds: Set<string>
  ): Promise<void> {
    const hideFromTimelineChanged = oldAlbum.hideFromTimeline !== newAlbum.hideFromTimeline;
    
    if (!hideFromTimelineChanged) {
      return;
    }

    if (newAlbum.hideFromTimeline) {
      // Property turned ON: Hide assets from timeline
      await this.assetRepository.updateAll(Array.from(assetIds), {
        visibility: AssetVisibility.AlbumHidden,
      });
    } else {
      // Property turned OFF: Restore assets to timeline (if not hidden by other albums)
      for (const assetId of assetIds) {
        const otherAlbumsWithAsset = await this.albumRepository.getByAssetId(auth.user.id, assetId);
        const stillHiddenByOtherAlbum = otherAlbumsWithAsset.some(
          (otherAlbum) => otherAlbum.id !== newAlbum.id && otherAlbum.hideFromTimeline
        );
        
        // Only restore to timeline if not hidden by any other album
        if (!stillHiddenByOtherAlbum) {
          await this.assetRepository.updateAll([assetId], {
            visibility: AssetVisibility.Timeline,
          });
        }
      }
    }
  }

  /**
   * Handles changes to the isExclusive property
   */
  private async handleExclusivePropertyChange(
    auth: AuthDto,
    oldAlbum: MapAlbumDto,
    newAlbum: MapAlbumDto,
    assetIds: Set<string>
  ): Promise<void> {
    const isExclusiveChanged = oldAlbum.isExclusive !== newAlbum.isExclusive;
    
    if (!isExclusiveChanged || !newAlbum.isExclusive) {
      return;
    }

    // Property turned ON: Remove assets from all other albums
    for (const assetId of assetIds) {
      const albumsWithAsset = await this.albumRepository.getByAssetId(auth.user.id, assetId);
      for (const otherAlbum of albumsWithAsset) {
        if (otherAlbum.id !== newAlbum.id) {
          await this.albumRepository.removeAssetIds(otherAlbum.id, [assetId]);
        }
      }
    }
  }

  private async findOrFail(id: string, options: AlbumInfoOptions) {
    const album = await this.albumRepository.getById(id, options);
    if (!album) {
      throw new BadRequestException('Album not found');
    }
    return album;
  }
}
